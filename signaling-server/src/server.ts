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

const storage = multer.memoryStorage()
const upload  = multer({ 
  storage, 
  limits: { 
    fileSize: STORED_MAX_BYTES,
    files: 20,
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
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many publish requests — try again in 15 minutes' },
})

const patchLimiter = rateLimit({
  windowMs: WINDOW_MS,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many update requests — try again in 15 minutes' },
})

const sessionLimiter = rateLimit({
  windowMs: WINDOW_MS,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many session requests — try again in 15 minutes' },
})

// Stricter limits for password attempts
const passwordLimiter = rateLimit({
  windowMs: WINDOW_MS,
  max: 10, // 10 attempts per 15 minutes
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many failed password attempts — try again later' },
  skipSuccessfulRequests: true, // Only count 4xx/5xx
})

// Retrieve is the enumeration attack surface — rate limited tightly
const retrieveLimiter = rateLimit({
  windowMs: WINDOW_MS,
  max: 15, // Max 15 lookups per 15 mins
  standardHeaders: true,
  legacyHeaders: false,
})

// File downloads — users may download multiple files per session
const fileLimiter = rateLimit({
  windowMs: WINDOW_MS,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many file download requests — try again in 15 minutes' },
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
        if (stats && stats.dataSize > 450 * 1024 * 1024) {
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
      
      const isLimit = err?.message?.includes('exceed') || err?.code === 'LIMIT_FILE_SIZE'
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
  requireStoredMode,
  upload.array('files'),
  async (req: Request, res: Response) => {
    let newlyUploadedIds: ObjectId[] = []
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
        if (stats && stats.dataSize > 450 * 1024 * 1024) {
          res.status(503).json({ error: 'Cloud storage is not available for now. The website is in update.' })
          return
        }
      }

      if (!text.trim() && uploadedFiles.length === 0) {
        res.status(400).json({ error: 'Nothing to publish — provide text or at least one file' })
        return
      }

      const existing = await StoredSession.findOne({ code, expiresAt: { $gt: new Date() } }).select('+password').lean()
      if (!existing) {
        res.status(404).json({ error: 'Session not found or expired — publish again to create a new one' })
        return
      }

      // Security: verify existing password before allowing update
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
          const existing = await StoredSession.findOne({ code, expiresAt: { $gt: new Date() } }).select('+password').lean()
          if (!existing) {
            res.status(404).json({ error: 'Session not found or expired — publish again to create a new one' })
            return
          }

          // Security: verify existing password before allowing update
          if (existing.password) {
            const clientPass = req.headers['x-session-password'] as string
            if (!clientPass || !(await verifyPassword(clientPass, existing.password))) {
              // Artificial delay to slow down automated brute force
              await new Promise(r => setTimeout(r, 500 + Math.random() * 1000))
              res.status(401).json({ error: 'password_required', message: 'Correct password required to update this session' })
              return
            }
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
          if (password) updateSet.password = await hashPassword(password)
          if (burnOnRead !== undefined) updateSet.burnOnRead = burnOnRead === 'true' || burnOnRead === true

          await StoredSession.updateOne({ code }, { $set: updateSet })

          // Delete old GridFS files only after session doc points to new ones
          const oldIds = existing.files.map((f) => f.gridfsId)
          if (oldIds.length > 0) await deleteFiles(oldIds)

          clearExpiryTimer(code)
          scheduleExpiry(code, expiresAt)

          console.log(`[publish] updated ${code} — expires ${expiresAt.toISOString()} — ${sanitisedFiles.length} file(s)`)
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
      res.status(500).json({ error: 'Server error during update', details: err?.message })
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

    if (session.burnOnRead) {
      logger.info({ code }, '[retrieve] burn-on-read triggered, deleting session')
      // Small delay to ensure the client receives the response first
      setTimeout(() => {
        clearExpiryTimer(code)
        deleteSessionAndFiles(code).catch(() => {})
      }, 3000).unref()
    }

    res.json({
      mode:      'stored',
      text:      session.text,
      expiresAt: session.expiresAt.getTime(),
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
      console.error('[file] stream error:', err)
      if (!res.headersSent) res.status(500).end()
    })

    stream.pipe(res)
  } catch (err) {
    console.error('[file] error:', err)
    if (!res.headersSent) res.status(500).json({ error: 'Failed to stream file' })
  }
})

app.get("/", (_req, res) => {
  res.send("Quick Share Server Running");
});

app.get("/health", (_req, res) => {
  res.status(200).json({ status: "ok" });
});

// ── GET /ice-servers — fetch ICE servers for WebRTC ──────────────────────────
// Returns STUN servers always. TURN can be added here with dynamic credential fetching.
// Phase 8: Integrate with Metered.ca or Cloudflare TURN for NAT traversal.

app.get('/ice-servers', async (_req: Request, res: Response) => {
  try {
    const response = await fetch(
      `https://global.relay.metered.ca/api/v1/turn/credentials?apiKey=${process.env.METERED_API_KEY}`
    )

    if (!response.ok) {
      logger.warn('[ice] Metered TURN unavailable')

      return res.json({
        iceServers: [
          { urls: 'stun:stun.l.google.com:19302' },
          { urls: 'stun:stun1.l.google.com:19302' }
        ],
        turnAvailable: false
      })
    }

    const turnServers = await response.json()

    const iceServers: IceServer[] = [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      ...turnServers
    ]

    return res.json({
      iceServers,
      turnAvailable: true
    })
  } catch (err) {
    logger.error({ err }, '[ice] Failed to fetch TURN credentials')

    return res.json({
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' }
      ],
      turnAvailable: false
    })
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
    console.error('[session] creation failed:', err)
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
        if (stats && stats.dataSize > 450 * 1024 * 1024) {
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
app.get('/stats', (req: Request, res: Response) => {
  const key = req.headers['x-stats-key']
  if (!process.env.STATS_KEY || key !== process.env.STATS_KEY) {
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

const wss = new WebSocketServer({
  server,
  verifyClient: ({ origin }, cb) => {
    const allowed =
      ALLOWED_ORIGINS.length === 0 ||
      ALLOWED_ORIGINS.includes('*') ||
      ALLOWED_ORIGINS.includes(origin ?? '')
    if (!allowed) cb(false, 403, 'Forbidden')
    else cb(true)
  },
})

wss.on('connection', handleConnection)
wss.on('error', (err) => console.error('[wss] error:', err))

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
  console.log(`[server] ${signal} — shutting down`)
  wss.clients.forEach((ws) => ws.close(1001, 'Server shutting down'))
  server.close(async () => {
    await mongoose.connection.close()
    console.log('[server] closed')
    process.exit(0)
  })
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT',  () => shutdown('SIGINT'))
