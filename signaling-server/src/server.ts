import express, { Request, Response, NextFunction } from 'express'
import http from 'http'
import mongoose from 'mongoose'
import { WebSocketServer } from 'ws'
import multer from 'multer'
import { ObjectId } from 'mongodb'
import { randomInt, randomBytes } from 'crypto'
import rateLimit from 'express-rate-limit'
import fs from 'fs'
import path from 'path'

import { createSession, activeSessions, getSession } from './sessionManager'
import { handleConnection } from './relay'
import { connectDB, StoredSession, uploadFile, getFileStream, scheduleExpiry, clearExpiryTimer, deleteFiles } from './db'

// ── Env ───────────────────────────────────────────────────────────────────────

const envPath = path.resolve(__dirname, '../.env')
if (fs.existsSync(envPath)) {
  fs.readFileSync(envPath, 'utf8')
    .split('\n')
    .forEach((line) => {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) return
      const [key, ...rest] = trimmed.split('=')
      if (key && !(key in process.env)) process.env[key] = rest.join('=')
    })
}

const PORT             = parseInt(process.env.PORT ?? '3001', 10)
const TTL_MS           = parseInt(process.env.SESSION_TTL_MS ?? '86400000', 10)
const ALLOWED_ORIGINS  = (process.env.ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim())
const STORED_MAX_BYTES = 10 * 1024 * 1024

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

// ── Multer ────────────────────────────────────────────────────────────────────

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: STORED_MAX_BYTES,
    files: 20,
    fieldSize: 1024 * 1024,
  },
})

// ── Express ───────────────────────────────────────────────────────────────────

const app = express()
app.use(express.json())

// CORS
app.use((req: Request, res: Response, next: NextFunction) => {
  const origin = req.headers.origin ?? ''
  if (
    ALLOWED_ORIGINS.length === 0 ||
    ALLOWED_ORIGINS.includes('*') ||
    ALLOWED_ORIGINS.includes(origin)
  ) {
    res.setHeader('Access-Control-Allow-Origin', origin || '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  }
  if (req.method === 'OPTIONS') { res.sendStatus(204); return }
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

// Retrieve is the enumeration attack surface — rate limited tightly
const retrieveLimiter = rateLimit({
  windowMs: WINDOW_MS,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many code lookup requests — try again in 15 minutes' },
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

// ── POST /publish — stored mode ───────────────────────────────────────────────

app.post(
  '/publish',
  publishLimiter,
  upload.array('files'),
  async (req: Request, res: Response) => {
    try {
      const text         = typeof req.body.text === 'string' ? req.body.text : ''
      const parsedTtl    = parseInt(req.body.ttlMs ?? '3600000', 10)
      const ttlMs        = Math.min(
        Math.max(Number.isNaN(parsedTtl) ? 3600000 : parsedTtl, 60 * 1000),
        TTL_MS
      )
      const uploadedFiles = (req.files as Express.Multer.File[] | undefined) ?? []

      const totalBytes = uploadedFiles.reduce((sum, f) => sum + f.size, 0)
      if (totalBytes > STORED_MAX_BYTES) {
        res.status(400).json({ error: 'Total file size exceeds 10 MB limit for stored mode' })
        return
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

      // Retry loop handles E11000 duplicate key (non-atomic check-then-insert race)
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          const code      = await generateUniqueStoredCode()
          const expiresAt = new Date(Date.now() + ttlMs)

          // FIX 3: Create doc with empty files first so expiry timer can always
          // find and clean it. If GridFS upload crashes after this, the orphan
          // scan on next restart cleans GridFS. No permanent leaks.
          await StoredSession.create({ code, text, files: [], expiresAt })

          const storedFiles = await Promise.all(
            sanitisedFiles.map(async (f) => {
              const gridfsId = await uploadFile(f.buffer, f.originalname, f.mimetype)
              const token    = generateFileToken()
              return { name: f.originalname, mimeType: f.mimetype, size: f.size, gridfsId, token }
            })
          )

          if (storedFiles.length > 0) {
            await StoredSession.updateOne({ code }, { $set: { files: storedFiles } })
          }

          scheduleExpiry(code, expiresAt)
          console.log(`[publish] stored ${code} — expires ${expiresAt.toISOString()} — ${sanitisedFiles.length} file(s)`)
          res.status(201).json({ code, mode: 'stored', expiresAt: expiresAt.getTime(), ttlMs })
          return
        } catch (err) {
          if (isE11000(err) && attempt < 4) {
            console.warn(`[publish] code collision on attempt ${attempt + 1}, retrying`)
            continue
          }
          throw err
        }
      }
    } catch (err) {
      console.error('[publish] error:', err)
      res.status(500).json({ error: 'Failed to publish' })
    }
  }
)

// ── PATCH /publish/:code — stored mode update ─────────────────────────────────

app.patch(
  '/publish/:code',
  patchLimiter,
  upload.array('files'),
  async (req: Request, res: Response) => {
    try {
      const code = req.params['code'] as string
      if (!/^\d{6}$/.test(code)) {
        res.status(400).json({ error: 'Invalid code format' })
        return
      }

      const text         = typeof req.body.text === 'string' ? req.body.text : ''
      const parsedTtl    = parseInt(req.body.ttlMs ?? '3600000', 10)
      const ttlMs        = Math.min(
        Math.max(Number.isNaN(parsedTtl) ? 3600000 : parsedTtl, 60 * 1000),
        TTL_MS
      )
      const uploadedFiles = (req.files as Express.Multer.File[] | undefined) ?? []

      const totalBytes = uploadedFiles.reduce((sum, f) => sum + f.size, 0)
      if (totalBytes > STORED_MAX_BYTES) {
        res.status(400).json({ error: 'Total file size exceeds 10 MB limit for stored mode' })
        return
      }

      if (!text.trim() && uploadedFiles.length === 0) {
        res.status(400).json({ error: 'Nothing to publish — provide text or at least one file' })
        return
      }

      const existing = await StoredSession.findOne({ code, expiresAt: { $gt: new Date() } }).lean()
      if (!existing) {
        res.status(404).json({ error: 'Session not found or expired — publish again to create a new one' })
        return
      }

      // Security: sanitise filenames
      const sanitisedFiles = uploadedFiles.map((f) => ({
        ...f,
        originalname: sanitiseFilename(f.originalname),
      }))

      // FIX 4: Upload new files BEFORE deleting old ones.
      // If crash between upload and delete: new files are orphaned (orphan scan cleans)
      // but session still has old refs → recipients still get old files. No data loss.
      // Old order (delete then upload) risked stale refs on crash.
      const storedFiles = await Promise.all(
        sanitisedFiles.map(async (f) => {
          const gridfsId = await uploadFile(f.buffer, f.originalname, f.mimetype)
          const token    = generateFileToken()
          return { name: f.originalname, mimeType: f.mimetype, size: f.size, gridfsId, token }
        })
      )

      const expiresAt = new Date(Date.now() + ttlMs)
      await StoredSession.updateOne({ code }, { $set: { text, files: storedFiles, expiresAt } })

      // Delete old GridFS files only after session doc points to new ones
      const oldIds = existing.files.map((f) => f.gridfsId)
      if (oldIds.length > 0) await deleteFiles(oldIds)

      clearExpiryTimer(code)
      scheduleExpiry(code, expiresAt)

      console.log(`[publish] updated ${code} — expires ${expiresAt.toISOString()} — ${sanitisedFiles.length} file(s)`)
      res.json({ code, mode: 'stored', expiresAt: expiresAt.getTime(), ttlMs })
    } catch (err) {
      console.error('[publish] update error:', err)
      res.status(500).json({ error: 'Failed to update session' })
    }
  }
)

// ── GET /retrieve/:code — stored mode ─────────────────────────────────────────

app.get('/retrieve/:code', retrieveLimiter, async (req: Request, res: Response) => {
  try {
    const code = req.params['code'] as string
    if (!/^\d{6}$/.test(code)) {
      res.status(400).json({ error: 'Invalid code format' })
      return
    }

    // FIX 5: Single DB query — check expiresAt in JS to avoid a second round trip.
    const session = await StoredSession.findOne({ code }).lean()

    if (!session) {
      // Not a stored session — check if it's an active live session
      const liveSession = getSession(code)
      res.status(404).json({ error: liveSession ? 'live_session' : 'not_found' })
      return
    }

    if (session.expiresAt <= new Date()) {
      res.status(410).json({ error: 'expired' })
      return
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
  } catch (err) {
    console.error('[retrieve] error:', err)
    res.status(500).json({ error: 'Failed to retrieve session' })
  }
})

// ── GET /file/:fileId/:token — stored mode file stream ────────────────────────
// Security: token is a random 32-char hex string stored per-file in the session doc.
// This prevents ObjectId guessing attacks — knowing a fileId is not enough to download.

app.get('/file/:fileId/:token', fileLimiter, async (req: Request, res: Response) => {
  try {
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
    } catch {
      res.status(400).json({ error: 'Invalid fileId' })
      return
    }

    // Verify file belongs to a non-expired session AND token matches
    const session = await StoredSession.findOne({
      'files.gridfsId': objectId,
      'files.token':    tokenParam,
      expiresAt:        { $gt: new Date() },
    }).lean()

    if (!session) {
      // Return same 404 whether file not found, token wrong, or session expired.
      // Do NOT distinguish — prevents oracle attacks.
      res.status(404).json({ error: 'File not found or session expired' })
      return
    }

    const { stream, filename, mimeType } = await getFileStream(objectId)

    res.setHeader('Content-Type', mimeType)
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`)

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

// ── POST /session — live mode ─────────────────────────────────────────────────

app.post('/session', sessionLimiter, (req: Request, res: Response) => {
  const requestedTtl = typeof req.body?.ttlMs === 'number' ? req.body.ttlMs : TTL_MS
  const effectiveTtl = Math.min(Math.max(requestedTtl, 60_000), TTL_MS)
  try {
    const code = createSession(effectiveTtl)
    res.status(201).json({ code, mode: 'live', expiresAt: Date.now() + effectiveTtl, ttlMs: effectiveTtl })
  } catch (err) {
    console.error('[session] creation failed:', err)
    res.status(503).json({ error: 'Failed to create session' })
  }
})

// ── GET /health ───────────────────────────────────────────────────────────────

app.get('/health', (_req: Request, res: Response) => {
  res.json({
    status:             'ok',
    activeLiveSessions: activeSessions(),
    mongoState:         mongoose.connection.readyState,
    uptime:             process.uptime(),
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

// ── Startup ───────────────────────────────────────────────────────────────────

async function start() {
  try {
    await connectDB()
    server.listen(PORT, () => {
      console.log(`[server] running on :${PORT}`)
      console.log(`[server] stored mode: ≤${STORED_MAX_BYTES / 1024 / 1024} MB`)
      console.log(`[server] live mode TTL max: ${TTL_MS / 1000}s`)
      console.log(`[server] allowed origins: ${ALLOWED_ORIGINS.join(', ') || 'all'}`)
    })
  } catch (err) {
    console.error('[server] startup failed:', err)
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
