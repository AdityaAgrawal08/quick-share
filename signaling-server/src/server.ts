import express, { Request, Response, NextFunction } from 'express'
import http from 'http'
import mongoose from 'mongoose'
import { WebSocketServer } from 'ws'
import multer from 'multer'
import { ObjectId } from 'mongodb'
import { randomInt, randomBytes } from 'crypto'
import rateLimit from 'express-rate-limit'
import path from 'path'
import crypto from 'crypto'
import { promisify } from 'util'

const scrypt = promisify(crypto.scrypt)

import { createSession, activeSessions, getSession } from './sessionManager'
import { handleConnection } from './relay'
import { connectDB, reconnectDB, isRetryableMongoError, StoredSession, uploadFile, getFileStream, scheduleExpiry, clearExpiryTimer, deleteFiles, deleteSessionAndFiles } from './db'

import logger from './logger'
import { CONFIG } from './config'

// Security: Global rejection handler
process.on('unhandledRejection', (reason, promise) => {
  logger.error({ reason, promise }, 'Unhandled Promise Rejection')
})

const PORT             = parseInt(process.env.PORT ?? '') || CONFIG.PORT || 3000
const TTL_MS           = CONFIG.SESSION_TTL_MS
const ALLOWED_ORIGINS  = CONFIG.ALLOWED_ORIGINS
const STORED_MAX_BYTES = CONFIG.STORED_MAX_BYTES
const STORED_TTL_MIN_MS = 1 * 60 * 1000
const STORED_TTL_MAX_MS = 60 * 60 * 1000
// Free-tier Atlas ceiling: refuse new uploads well before the hard quota so
// maintenance/deletion traffic still has headroom.
const MAX_DATA_SIZE_BYTES = 450 * 1024 * 1024

// Burn-on-read: after the first successful retrieve the content is gone for
// new readers, but the recipient still needs a window to download the files
// listed in that response. 3s was far too short — any human-paced click on
// "Download" landed after deletion and got a 404.
const BURN_GRACE_MS = 60 * 1000

type IceServer = {
  urls: string | string[]
  username?: string
  credential?: string
}

function isRetryablePublishError(err: unknown): boolean {
  return isRetryableMongoError(err)
}

let storedModeEnabled = false

function requireStoredMode(_req: Request, res: Response, next: NextFunction) {
  if (!storedModeEnabled) {
    res.status(503).json({ error: 'stored_mode_disabled', message: 'Stored mode requires MongoDB (set MONGODB_URI)' })
    return
  }
  next()
}

// ── Helpers ───────────────────────────────────────────────────────────────────

// Security: sanitise uploaded filenames before storing in DB or GridFS.
// Takes basename only (strips path), removes null bytes and double-dots.
function sanitiseFilename(name: string): string {
  const base = name.replace(/\\/g, '/').split('/').pop() ?? ''
  const sanitised = base
    .replace(/\x00/g, '')
    .replace(/\.\./g, '')
    .trim()
    .slice(0, 255)
  return sanitised || 'file'
}

// Security: generate a cryptographically random download token (32 hex chars).
// Stored per-file in the session doc; required in the download URL.
// Prevents ObjectId guessing attacks against /file/:fileId.
function generateFileToken(): string {
  return randomBytes(16).toString('hex')
}

// Security: detect MongoDB duplicate key error (E11000).
function isE11000(err: unknown): boolean {
  return (
    err != null &&
    typeof err === 'object' &&
    'code' in err &&
    (err as { code: unknown }).code === 11000
  )
}

function clampStoredTtlMs(ttlMs: number): number {
  return Math.min(Math.max(ttlMs, STORED_TTL_MIN_MS), STORED_TTL_MAX_MS)
}

function getTextBytes(text: string): number {
  return Buffer.byteLength(text, 'utf8')
}

// ── Multer ────────────────────────────────────────────────────────────────────

// Multer's limits are PER FILE — with memoryStorage, 20 × 10MB files buffer
// ~200MB per request before our totalBytes check ever runs. Two mitigations:
//   1. Cap file count (10) so worst-case buffering per request is bounded.
//   2. A concurrency gate limiting simultaneous heavy uploads.
const MAX_UPLOAD_FILES = 10
const HEAVY_CONCURRENCY = 3
const HEAVY_QUEUE_TIMEOUT_MS = 10_000

class Gate {
  private slots: number
  private waiters: (() => void)[] = []
  constructor(n: number) { this.slots = n }
  // Resolves with a releaser once a slot is held. The caller MUST eventually
  // invoke it exactly once — this keeps accounting correct even if the caller
  // gave up waiting (timeout) before the slot was granted.
  async acquire(): Promise<() => void> {
    if (this.slots > 0) {
      this.slots--
      return () => this.release()
    }
    return new Promise<() => void>(resolve => {
      this.waiters.push(() => {
        this.slots--
        resolve(() => this.release())
      })
    })
  }
  release(): void {
    this.slots++
    const next = this.waiters.shift()
    if (next) next()
  }
}
const heavyGate = new Gate(HEAVY_CONCURRENCY)

function gate(_req: Request, res: Response, next: NextFunction): void {
  let releaser: (() => void) | null = null
  let released = false
  const releaseOnce = () => {
    if (releaser && !released) {
      released = true
      releaser()
    }
  }

  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    releaseOnce()          // no-op if the slot wasn't granted yet
    res.status(503).json({ error: 'Server busy — try again shortly' })
  }, HEAVY_QUEUE_TIMEOUT_MS)
  timer.unref?.()

  heavyGate.acquire().then(rel => {
    clearTimeout(timer)
    if (timedOut || res.writableFinished || res.writableEnded) {
      // Request already answered via timeout or aborted — give the slot back
      // untouched so concurrency accounting stays balanced.
      rel()
      return
    }
    releaser = rel
    res.once('finish', releaseOnce)
    res.once('close', releaseOnce)
    next()
  })
}

const storage = multer.memoryStorage()
const upload  = multer({
  storage,
  limits: {
    fileSize: STORED_MAX_BYTES,
    files: MAX_UPLOAD_FILES,
    fieldSize: 1024 * 1024,
  },
})

// ── Express ───────────────────────────────────────────────────────────────────

const app = express()
app.set('trust proxy', 1)
app.use(express.json({ limit: '2mb' }))

// Security: Global Security Headers & CORS
app.use((req: Request, res: Response, next: NextFunction) => {
  const origin = req.headers.origin as string | undefined
  const isAllowed =
    !CONFIG.ALLOWED_ORIGINS.length ||
    CONFIG.ALLOWED_ORIGINS.includes('*') ||
    (origin !== undefined && CONFIG.ALLOWED_ORIGINS.includes(origin))
  // Basic security headers
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('X-Frame-Options', 'DENY')
  res.setHeader('X-XSS-Protection', '1; mode=block')
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin')
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains')

  if (origin && isAllowed) {
    res.setHeader('Access-Control-Allow-Origin', origin)
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-session-password')
    res.setHeader('Access-Control-Allow-Credentials', 'true')
  }

  // Preflight
  if (req.method === 'OPTIONS') {
    res.sendStatus(204)
    return
  }

  // Block unsafe methods from unauthorized origins
  const isUnsafe = ['POST', 'PATCH', 'PUT', 'DELETE'].includes(req.method.toUpperCase())
  if (isUnsafe && !isAllowed) {
    res.status(403).json({ error: 'Origin not allowed' })
    return
  }

  next()
})

// ── Rate limiting ─────────────────────────────────────────────────────────────

const WINDOW_MS = 15 * 60 * 1000 // 15 minutes

// Stricter limits on creation endpoints (publish, session)
const publishLimiter = rateLimit({
  windowMs: WINDOW_MS,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many publish requests — try again in 15 minutes' },
})

const patchLimiter = rateLimit({
  windowMs: WINDOW_MS,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many update requests — try again in 15 minutes' },
})

const sessionLimiter = rateLimit({
  windowMs: WINDOW_MS,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many session requests — try again in 15 minutes' },
})

// Stricter limits for password attempts
const passwordLimiter = rateLimit({
  windowMs: WINDOW_MS,
  limit: 10, // 10 attempts per 15 minutes
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many failed password attempts — try again later' },
  skipSuccessfulRequests: true, // Only count 4xx/5xx
})

// Retrieve is the enumeration attack surface — rate limited tightly.
// Generous enough for several recipients behind one shared NAT (QR-code flow).
const retrieveLimiter = rateLimit({
  windowMs: WINDOW_MS,
  limit: 40,
  standardHeaders: true,
  legacyHeaders: false,
})

// File downloads — users may download multiple files per session
const fileLimiter = rateLimit({
  windowMs: WINDOW_MS,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many file download requests — try again in 15 minutes' },
})

// ICE endpoint proxies an external Metered API call — protect the key/budget
const iceLimiter = rateLimit({
  windowMs: WINDOW_MS,
  limit: 120,
  standardHeaders: true,
  legacyHeaders: false,
})

// ── Code generation ───────────────────────────────────────────────────────────

function generateCode(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, '0')
}

async function generateUniqueStoredCode(): Promise<string> {
  for (let i = 0; i < 20; i++) {
    const code = generateCode()
    const inMongo = await StoredSession.findOne({ code }).lean()
    const inMemory = getSession(code)
    if (!inMongo && !inMemory) return code
  }
  throw new Error('Failed to generate unique stored session code')
}

// ── Password Hashing ──────────────────────────────────────────────────────────

async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16).toString('hex')
  const derivedKey = (await scrypt(password, salt, 64)) as Buffer
  return `${salt}:${derivedKey.toString('hex')}`
}

async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [salt, key] = stored.split(':')
  const derivedKey = (await scrypt(password, salt, 64)) as Buffer
  const derivedKeyHex = derivedKey.toString('hex')
  if (derivedKeyHex.length !== key.length) return false
  return crypto.timingSafeEqual(Buffer.from(derivedKeyHex), Buffer.from(key))
}

// ── POST /publish — stored mode ───────────────────────────────────────────────

app.post(
  '/publish',
  publishLimiter,
  gate,
  requireStoredMode,
  upload.array('files'),
  async (req: Request, res: Response) => {
    try {
      // Security: Basic text sanitisation (remove script tags etc)
      let text = typeof req.body.text === 'string' ? req.body.text : ''
      text = text.replace(/<script\b[^>]*>([\s\S]*?)<\/script>/gim, '').trim()
      
      const password = typeof req.body.password === 'string' ? req.body.password.trim() : ''
      const burnOnRead = req.body.burnOnRead === 'true' || req.body.burnOnRead === true
      if (!password) {
        res.status(400).json({ error: 'Password is required' })
        return
      }
      
      const parsedTtl    = parseInt(req.body.ttlMs ?? '3600000', 10)
      const ttlMs        = clampStoredTtlMs(Number.isNaN(parsedTtl) ? STORED_TTL_MAX_MS : parsedTtl)
      const uploadedFiles = (req.files as Express.Multer.File[] | undefined) ?? []

      const totalBytes = uploadedFiles.reduce((sum, f) => sum + f.size, 0) + getTextBytes(text)
      if (totalBytes > STORED_MAX_BYTES) {
        res.status(400).json({ error: 'Total payload exceeds 10 MB limit for stored mode' })
        return
      }

      if (mongoose.connection.db) {
        const stats = await mongoose.connection.db.stats()
        if (stats && stats.dataSize > MAX_DATA_SIZE_BYTES) {
          res.status(503).json({ error: 'Cloud storage is not available for now. The website is in update.' })
          return
        }
      }

      if (!text.trim() && uploadedFiles.length === 0) {
        res.status(400).json({ error: 'Nothing to publish — provide text or at least one file' })
        return
      }

      // Security: sanitise filenames before storing
      const sanitisedFiles = uploadedFiles.map((f) => ({
        ...f,
        originalname: sanitiseFilename(f.originalname),
      }))
      let lastErr: unknown

      for (let retryAttempt = 0; retryAttempt < 2; retryAttempt++) {
        let newlyUploadedIds: ObjectId[] = []
        try {
          // Upload files to GridFS FIRST.
          const storedFiles = await Promise.all(
            sanitisedFiles.map(async (f) => {
              const gridfsId = await uploadFile(f.buffer, f.originalname, f.mimetype)
              newlyUploadedIds.push(gridfsId)
              const token    = generateFileToken()
              return { name: f.originalname, mimeType: f.mimetype, size: f.size, gridfsId, token }
            })
          )

          const hashedPassword = await hashPassword(password)

          // Retry loop handles E11000 duplicate key (non-atomic check-then-insert race)
          for (let attempt = 0; attempt < 5; attempt++) {
            try {
              const code      = await generateUniqueStoredCode()
              const expiresAt = new Date(Date.now() + ttlMs)

              // Create the session doc with the uploaded files already attached.
              // This ensures that we never have a session with empty files if an upload fails.
              await StoredSession.create({ code, text, files: storedFiles, expiresAt, password: hashedPassword, burnOnRead })

              scheduleExpiry(code, expiresAt)
              logger.info(`[publish] stored ${code} — expires ${expiresAt.toISOString()} — ${sanitisedFiles.length} file(s)`)
              res.status(201).json({ code, mode: 'stored', expiresAt: expiresAt.getTime(), ttlMs })
              return
            } catch (err) {
              if (isE11000(err) && attempt < 4) {
                logger.warn(`[publish] code collision on attempt ${attempt + 1}, retrying`)
                continue
              }
              throw err
            }
          }
        } catch (err: any) {
          lastErr = err
          if (newlyUploadedIds.length > 0) {
            await deleteFiles(newlyUploadedIds).catch(dErr => logger.error({ err: dErr }, '[publish] double-failure during cleanup'))
            logger.info({ count: newlyUploadedIds.length }, '[publish] cleaned up GridFS files after failure')
          }

          if (retryAttempt === 0 && CONFIG.MONGODB_URI && isRetryablePublishError(err)) {
            logger.warn({ err }, '[publish] transient MongoDB/TLS failure — reconnecting and retrying once')
            await reconnectDB()
            continue
          }

          throw err
        }
      }

      throw lastErr ?? new Error('Server error during publish')
    } catch (err: any) {
      logger.error({ err }, '[publish] error')

      const isLimit = err?.message?.includes('exceed') || err?.code === 'LIMIT_FILE_SIZE' || err?.code === 'LIMIT_FILE_COUNT'
      res.status(isLimit ? 400 : 500).json({
        error: isLimit ? 'Upload limit exceeded' : 'Server error during publish',
        details: err?.message
      })
    }
  }
)

// ── PATCH /publish/:code — stored mode update ─────────────────────────────────

app.patch(
  '/publish/:code',
  patchLimiter,
  gate,
  requireStoredMode,
  upload.array('files'),
  async (req: Request, res: Response) => {
    try {
      const code = req.params['code'] as string
      if (!/^\d{6}$/.test(code)) {
        res.status(400).json({ error: 'Invalid code format' })
        return
      }

      const text         = typeof req.body.text === 'string' ? req.body.text : ''
      const burnOnRead   = req.body.burnOnRead
      const parsedTtl    = parseInt(req.body.ttlMs ?? '3600000', 10)
      const ttlMs        = clampStoredTtlMs(Number.isNaN(parsedTtl) ? STORED_TTL_MAX_MS : parsedTtl)
      const uploadedFiles = (req.files as Express.Multer.File[] | undefined) ?? []

      const totalBytes = uploadedFiles.reduce((sum, f) => sum + f.size, 0) + getTextBytes(text)
      if (totalBytes > STORED_MAX_BYTES) {
        res.status(400).json({ error: 'Total payload exceeds 10 MB limit for stored mode' })
        return
      }

      if (mongoose.connection.db) {
        const stats = await mongoose.connection.db.stats()
        if (stats && stats.dataSize > MAX_DATA_SIZE_BYTES) {
          res.status(503).json({ error: 'Cloud storage is not available for now. The website is in update.' })
          return
        }
      }

      if (!text.trim() && uploadedFiles.length === 0) {
        res.status(400).json({ error: 'Nothing to publish — provide text or at least one file' })
        return
      }

      // Security: verify ownership ONCE before the retry loop — re-verifying
      // inside each attempt was redundant (same request, same credentials).
      const existing = await StoredSession.findOne({ code, expiresAt: { $gt: new Date() } }).select('+password').lean()
      if (!existing) {
        res.status(404).json({ error: 'Session not found or expired — publish again to create a new one' })
        return
      }

      if (existing.password) {
        const clientPass = req.headers['x-session-password'] as string
        if (!clientPass || !(await verifyPassword(clientPass, existing.password))) {
          // Artificial delay to slow down automated brute force
          await new Promise(r => setTimeout(r, 500 + Math.random() * 1000))
          res.status(401).json({ error: 'password_required', message: 'Correct password required to update this session' })
          return
        }
      }

      // Security: sanitise filenames
      const sanitisedFiles = uploadedFiles.map((f) => ({
        ...f,
        originalname: sanitiseFilename(f.originalname),
      }))
      let lastErr: unknown

      for (let retryAttempt = 0; retryAttempt < 2; retryAttempt++) {
        let newlyUploadedIds: ObjectId[] = []
        try {
          // Fresh read per attempt: oldIds must reflect the doc state right
          // before this update so we never delete files a previous attempt
          // already swapped in. Password is NOT re-checked — credentials were
          // validated above and cannot change mid-request.
          const current = await StoredSession.findOne({ code }).lean()
          if (!current || (current.expiresAt && current.expiresAt <= new Date())) {
            res.status(404).json({ error: 'Session not found or expired — publish again to create a new one' })
            return
          }

          const storedFiles = await Promise.all(
            sanitisedFiles.map(async (f) => {
              const gridfsId = await uploadFile(f.buffer, f.originalname, f.mimetype)
              newlyUploadedIds.push(gridfsId)
              const token    = generateFileToken()
              return { name: f.originalname, mimeType: f.mimetype, size: f.size, gridfsId, token }
            })
          )

          const expiresAt = new Date(Date.now() + ttlMs)
          const password = typeof req.body.password === 'string' && req.body.password.trim() ? req.body.password : null
          const updateSet: any = { text, files: storedFiles, expiresAt }
          // New content = readable again. Without this, a burn-on-read
          // session that was updated after its first read stayed 410 forever.
          updateSet.burnedAt = null
          if (password) updateSet.password = await hashPassword(password)
          if (burnOnRead !== undefined) updateSet.burnOnRead = burnOnRead === 'true' || burnOnRead === true

          await StoredSession.updateOne({ code }, { $set: updateSet })

          // Delete old GridFS files only after session doc points to new ones
          const oldIds = current.files.map((f) => f.gridfsId)
          if (oldIds.length > 0) await deleteFiles(oldIds)

          clearExpiryTimer(code)
          scheduleExpiry(code, expiresAt)

          logger.info({ code, files: sanitisedFiles.length, expiresAt: expiresAt.toISOString() }, '[publish] updated stored session')
          res.json({ code, mode: 'stored', expiresAt: expiresAt.getTime(), ttlMs })
          return
        } catch (err: any) {
          lastErr = err
          if (newlyUploadedIds.length > 0) {
            await deleteFiles(newlyUploadedIds).catch(dErr => logger.error({ err: dErr }, '[publish] double-failure during update cleanup'))
          }

          if (retryAttempt === 0 && CONFIG.MONGODB_URI && isRetryablePublishError(err)) {
            logger.warn({ err }, '[publish] transient MongoDB/TLS failure during update — reconnecting and retrying once')
            await reconnectDB()
            continue
          }

          throw err
        }
      }

      throw lastErr ?? new Error('Server error during update')
    } catch (err: any) {
      logger.error({ err }, '[publish] update error')
      const isLimit = err?.message?.includes('exceed') || err?.code === 'LIMIT_FILE_SIZE' || err?.code === 'LIMIT_FILE_COUNT'
      res.status(isLimit ? 400 : 500).json({
        error: isLimit ? 'Upload limit exceeded' : 'Server error during update',
        details: err?.message
      })
    }
  }
)

// ── GET /retrieve/:code — stored mode ─────────────────────────────────────────

app.get('/retrieve/:code', retrieveLimiter, passwordLimiter, async (req: Request, res: Response) => {
  try {
    const code = req.params['code'] as string
    if (!/^\d{6}$/.test(code)) {
      res.status(400).json({ error: 'Invalid code format' })
      return
    }

    // If Mongo isn't configured, only live sessions can be retrieved.
    if (!storedModeEnabled) {
      const liveSession = getSession(code)
      if (!liveSession) await new Promise(r => setTimeout(r, 800))
      res.status(404).json({ error: liveSession ? 'live_session' : 'not_found' })
      return
    }

    // Single DB query — check session existence
    const session = await StoredSession.findOne({ code }).select('+password').lean()

    if (!session) {
      // Not a stored session — check if it's an active live session
      const liveSession = getSession(code)
      if (!liveSession) await new Promise(r => setTimeout(r, 800))
      res.status(404).json({ error: liveSession ? 'live_session' : 'not_found' })
      return
    }

    // Burn-on-read session that was already read — content is gone.
    if (session.burnedAt) {
      res.status(410).json({ error: 'burned' })
      return
    }

    // Password verification
    if (session.password) {
      const clientPass = req.headers['x-session-password'] as string
      if (!clientPass || !(await verifyPassword(clientPass, session.password))) {
        // Security: Artificial delay to slow down brute force (in addition to rate limiting)
        await new Promise(r => setTimeout(r, 500 + Math.random() * 1000))
        res.status(401).json({ error: 'password_required', message: 'This session is password protected' })
        return
      }
    }

    if (session.expiresAt <= new Date()) {
      res.status(410).json({ error: 'expired' })
      return
    }

    // Burn-on-read: mark atomically so exactly ONE retrieve ever sees the
    // content, then keep files alive for BURN_GRACE_MS so the recipient can
    // actually download what was just announced to them.
    let burnGraceMs: number | null = null
    if (session.burnOnRead) {
      const marked = await StoredSession.updateOne(
        { code, burnedAt: null },
        { $set: { burnedAt: new Date() } }
      )
      if (marked.modifiedCount === 1) {
        burnGraceMs = BURN_GRACE_MS
        logger.info({ code, graceMs: BURN_GRACE_MS }, '[retrieve] burn-on-read triggered')
        setTimeout(() => {
          clearExpiryTimer(code)
          deleteSessionAndFiles(code).catch(() => {})
        }, BURN_GRACE_MS).unref()
      } else {
        // Lost a concurrent race — another reader burned it first.
        res.status(410).json({ error: 'burned' })
        return
      }
    }

    res.json({
      mode:      'stored',
      text:      session.text,
      expiresAt: session.expiresAt.getTime(),
      burnOnRead: !!session.burnOnRead,
      ...(burnGraceMs ? { burnGraceMs } : {}),
      files:     session.files.map((f) => ({
        name:     f.name,
        mimeType: f.mimeType,
        size:     f.size,
        fileId:   f.gridfsId.toString(),
        token:    f.token,   // Security: token required in download URL
      })),
    })
  } catch (err: any) {
    logger.error({ err }, '[retrieve] error')
    res.status(500).json({ error: `Failed to retrieve session: ${err?.message || 'Unknown error'}` })
  }
})

// ── GET /file/:fileId/:token — stored mode file stream ────────────────────────
// Security: token is a random 32-char hex string stored per-file in the session doc.
// This prevents ObjectId guessing attacks — knowing a fileId is not enough to download.

app.get('/file/:fileId/:token', fileLimiter, async (req: Request, res: Response) => {
  try {
    if (!storedModeEnabled) {
      res.status(503).json({ error: 'stored_mode_disabled' })
      return
    }

    const fileIdParam = req.params['fileId'] as string
    const tokenParam  = req.params['token']  as string

    // Validate token format before touching DB
    if (!/^[0-9a-f]{32}$/.test(tokenParam)) {
      res.status(400).json({ error: 'Invalid token format' })
      return
    }

    let objectId: ObjectId
    try {
      objectId = new ObjectId(fileIdParam)
    } catch (err) {
      res.status(400).json({ error: 'Invalid fileId' })
      return
    }

    // Verify file belongs to a non-expired session AND token matches
    const session = await StoredSession.findOne({
      'files.gridfsId': objectId,
      'files.token':    tokenParam,
      expiresAt:        { $gt: new Date() },
    }).select('+password').lean()

    if (!session) {
      // Return same 404 whether file not found, token wrong, or session expired.
      // Do NOT distinguish — prevents oracle attacks.
      res.status(404).json({ error: 'File not found or session expired' })
      return
    }

    if (session.password) {
      const clientPass = req.headers['x-session-password'] as string
      if (!clientPass || !(await verifyPassword(clientPass, session.password))) {
        res.status(401).json({ error: 'forbidden' })
        return
      }
    }

    const { stream, filename, mimeType } = await getFileStream(objectId)

    res.setHeader('Content-Type', mimeType)
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`)
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox")

    stream.on('error', (err) => {
      logger.error({ err }, '[file] stream error')
      if (!res.headersSent) res.status(500).end()
    })

    stream.pipe(res)
  } catch (err) {
    logger.error({ err }, '[file] error')
    if (!res.headersSent) res.status(500).json({ error: 'Failed to stream file' })
  }
})

app.get("/", (_req, res) => {
  res.send("Quick Share Server Running");
});

// NOTE: the detailed /health handler lives further down this file. A second,
// bare "/health" used to be registered here and silently shadowed it — which
// broke the client's stored-mode feature detection. Keep exactly one.

// ── GET /ice-servers — fetch ICE servers for WebRTC ──────────────────────────
// Returns STUN servers always; TURN credentials from Metered when configured.
// The Metered response is cached server-side (credentials are short-lived but
// outlive a 30 min cache) so this endpoint can never be used to amplify calls
// to — and billing on — the upstream API.
const ICE_CACHE_TTL_MS = 30 * 60 * 1000
const ICE_NEGATIVE_TTL_MS = 5 * 60 * 1000
const STUN_ONLY = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ],
  turnAvailable: false,
}
let iceCache: { body: unknown; expiresAt: number } | null = null

app.get('/ice-servers', iceLimiter, async (_req: Request, res: Response) => {
  if (iceCache && Date.now() < iceCache.expiresAt) {
    return res.json(iceCache.body)
  }

  const apiKey = process.env.METERED_API_KEY
  if (!apiKey) {
    logger.warn('[ice] METERED_API_KEY not set — serving STUN only')
    iceCache = { body: STUN_ONLY, expiresAt: Date.now() + ICE_CACHE_TTL_MS }
    return res.json(STUN_ONLY)
  }

  try {
    const response = await fetch(
      `https://global.relay.metered.ca/api/v1/turn/credentials?apiKey=${encodeURIComponent(apiKey)}`,
      { signal: AbortSignal.timeout(5000) }
    )

    if (!response.ok) {
      logger.warn({ status: response.status }, '[ice] Metered TURN unavailable')
      iceCache = { body: STUN_ONLY, expiresAt: Date.now() + ICE_NEGATIVE_TTL_MS }
      return res.json(STUN_ONLY)
    }

    const turnServers = await response.json() as IceServer[]
    const body = {
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        ...turnServers,
      ],
      turnAvailable: true,
    }
    iceCache = { body, expiresAt: Date.now() + ICE_CACHE_TTL_MS }
    return res.json(body)
  } catch (err) {
    logger.error({ err }, '[ice] Failed to fetch TURN credentials')
    // Short negative cache so an outage doesn't turn into a retry storm.
    iceCache = { body: STUN_ONLY, expiresAt: Date.now() + ICE_NEGATIVE_TTL_MS }
    return res.json(STUN_ONLY)
  }
})

// ── POST /session — live mode ─────────────────────────────────────────────────

app.post('/session', sessionLimiter, async (req: Request, res: Response) => {
  const requestedTtl = typeof req.body?.ttlMs === 'number' ? req.body.ttlMs : TTL_MS
  const effectiveTtl = Math.min(Math.max(requestedTtl, 60_000), TTL_MS)
  const password = typeof req.body?.password === 'string' ? req.body.password.trim() : ''
  
  if (!password) {
    res.status(400).json({ error: 'Password is required' })
    return
  }

  try {
    const hashedPassword = await hashPassword(password)
    const code = createSession(effectiveTtl, hashedPassword)
    res.status(201).json({ code, mode: 'live', expiresAt: Date.now() + effectiveTtl, ttlMs: effectiveTtl })
  } catch (err) {
    logger.error({ err }, '[session] creation failed')
    res.status(503).json({ error: 'Failed to create session' })
  }
})

// ── GET /health ───────────────────────────────────────────────────────────────

app.get('/health', async (_req: Request, res: Response) => {
  let mongoPing = -1
  let gridfsStatus = 'unknown'
  let isStorageFull = false
  
  if (storedModeEnabled) {
    try {
      const start = Date.now()
      if (mongoose.connection.db) {
        await mongoose.connection.db.admin().ping()
        mongoPing = Date.now() - start
        gridfsStatus = 'connected'
        const stats = await mongoose.connection.db.stats()
        if (stats && stats.dataSize > MAX_DATA_SIZE_BYTES) {
          isStorageFull = true
        }
      }
    } catch (err) {
      mongoPing = -2
      gridfsStatus = 'failed'
    }
  }

  res.json({
    status:             mongoPing === -2 ? 'degraded' : 'ok',
    version:            '1.1.0',
    storedModeEnabled:  storedModeEnabled && !isStorageFull,
    isStorageFull,
    mongoLatency:       mongoPing,
    gridfsStatus,
    activeLiveSessions: activeSessions(),
    uptime:             Math.floor(process.uptime()),
  })
})

// ── GET /stats — Phase 10: Monitoring ──────────────────────────────────────────
// Requires STATS_KEY environment variable. Provides insight into server load.
function timingSafeStrEqual(a: unknown, b: unknown): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  const bufA = Buffer.from(a)
  const bufB = Buffer.from(b)
  if (bufA.length !== bufB.length) {
    // Burn comparable time to avoid a length oracle.
    crypto.timingSafeEqual(bufA, bufA)
    return false
  }
  return crypto.timingSafeEqual(bufA, bufB)
}

app.get('/stats', (req: Request, res: Response) => {
  const key = req.headers['x-stats-key']
  if (!timingSafeStrEqual(key, process.env.STATS_KEY) || !process.env.STATS_KEY) {
    res.status(403).json({ error: 'forbidden' })
    return
  }
  
  res.json({
    activeSessions: activeSessions(),
    clientsCount:   wss.clients.size,
    memoryUsage:    process.memoryUsage(),
    cpuUsage:       process.cpuUsage(),
    platform:       process.platform,
    arch:           process.arch,
    nodeVersion:    process.version,
  })
})

// ── HTTP + WebSocket servers ──────────────────────────────────────────────────

const server = http.createServer(app)

// Origin check happens in an explicit upgrade handler — `verifyClient` is a
// deprecated ws API and is scheduled for removal.
const wss = new WebSocketServer({ noServer: true })

server.on('upgrade', (req, socket, head) => {
  const origin = req.headers.origin ?? ''
  const allowed =
    ALLOWED_ORIGINS.length === 0 ||
    ALLOWED_ORIGINS.includes('*') ||
    ALLOWED_ORIGINS.includes(origin)
  if (!allowed) {
    socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
    socket.destroy()
    return
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req))
})

wss.on('connection', handleConnection)
wss.on('error', (err) => logger.error({ err }, '[wss] error'))

// ── WebSocket Heartbeat ───────────────────────────────────────────────────────
// Send ping every 30s to detect dead connections. Clients should respond with pong.
const HEARTBEAT_INTERVAL_MS = 30 * 1000

const heartbeatInterval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if ((ws as any).isAlive === false) {
      ws.terminate()
      return
    }
    (ws as any).isAlive = false
    ws.ping()
  })
}, HEARTBEAT_INTERVAL_MS)
if (heartbeatInterval.unref) heartbeatInterval.unref()

// ── Error Handling ───────────────────────────────────────────────────────────
app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  logger.error({ err }, 'Unhandled error')
  
  const status = err.status || 500
  const isProduction = process.env.NODE_ENV === 'production'
  
  res.status(status).json({
    error: status === 500 ? 'internal_server_error' : err.message,
    message: status === 500 ? 'Something went wrong on our end. Please try again later.' : err.message,
    ...(isProduction ? {} : { stack: err.stack })
  })
})

// ── Startup ───────────────────────────────────────────────────────────────────

async function start() {
  try {
    if (CONFIG.MONGODB_URI) {
      try {
        await connectDB()
        storedModeEnabled = true
        logger.info('[server] Connected to MongoDB — Stored Mode enabled')
      } catch (dbErr) {
        logger.error({ err: dbErr }, '[server] MongoDB connection failed — entering live-only mode')
        storedModeEnabled = false
      }
    } else {
      logger.warn('[server] MONGODB_URI not set — starting in live-only mode')
    }

    server.once('error', async (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        logger.error({ err, port: PORT }, `[server] port ${PORT} is already in use — stop the existing process or set PORT to a free value`)
      } else {
        logger.error({ err }, '[server] server listen failed')
      }

      try {
        await mongoose.connection.close()
      } catch {
        // ignore shutdown errors
      }
      process.exit(1)
    })

    server.listen(PORT, '0.0.0.0', () => {
      logger.info({
        msg: 'Server started',
        port: PORT,
        storedMax: `${STORED_MAX_BYTES / 1024 / 1024}MB`,
        liveTTL: `${TTL_MS / 1000}s`,
        origins: CONFIG.ALLOWED_ORIGINS.length ? CONFIG.ALLOWED_ORIGINS : '*',
        storedMode: storedModeEnabled
      })
    })
  } catch (err) {
    logger.error({ err }, '[server] startup failed')
    process.exit(1)
  }
}

start()

// ── Graceful shutdown ─────────────────────────────────────────────────────────

function shutdown(signal: string) {
  logger.warn({ signal }, '[server] shutting down')
  wss.clients.forEach((ws) => ws.close(1001, 'Server shutting down'))
  server.close(async () => {
    await mongoose.connection.close()
    logger.info('[server] closed')
    process.exit(0)
  })
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT',  () => shutdown('SIGINT'))
