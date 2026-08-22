import mongoose from 'mongoose'
import { GridFSBucket, ObjectId } from 'mongodb'
import logger from './logger'
import { Readable } from 'stream'

import { CONFIG } from './config'

let bucket: GridFSBucket | null = null
const MONGOOSE_OPTIONS = {
  serverSelectionTimeoutMS: 5000,
  connectTimeoutMS: 5000,
  socketTimeoutMS: 10000,
  retryWrites: true,
}

// In-memory map of active expiry timers: code → NodeJS.Timeout
const expiryTimers = new Map<string, ReturnType<typeof setTimeout>>()

// Number of GridFS uploads currently streaming. Orphan scans must not run
// while this is > 0: GridFS writes .chunks progressively but only creates the
// .files document on finish, so an in-flight upload looks "orphaned".
let activeUploads = 0

// ── Maintenance Locks ─────────────────────────────────────────────────────────
let isMaintenanceRunning = false

// ── Connection ────────────────────────────────────────────────────────────────

export async function connectDB(): Promise<void> {
  const uri = CONFIG.MONGODB_URI
  if (!uri) throw new Error('MONGODB_URI not set in environment')

  await mongoose.connect(uri, getMongoOptions())
  await refreshBucket('connected')

  // On startup: recover timers and clean up any orphaned data from a
  // previous server crash. Order matters: orphan scan first, then timers.
  await runMaintenance()
}

export async function reconnectDB(): Promise<void> {
  const uri = CONFIG.MONGODB_URI
  if (!uri) throw new Error('MONGODB_URI not set in environment')

  try {
    await mongoose.disconnect()
  } catch {
    // ignore disconnect failures; we'll attempt a fresh connect below
  }

  await mongoose.connect(uri, getMongoOptions())
  await refreshBucket('reconnected')
}

function getMongoOptions() {
  if (!CONFIG.MONGODB_TLS_INSECURE) return MONGOOSE_OPTIONS

  return {
    ...MONGOOSE_OPTIONS,
    tlsInsecure: true,
    tlsAllowInvalidCertificates: true,
    tlsAllowInvalidHostnames: true,
  }
}

function refreshBucket(state: 'connected' | 'reconnected'): void {
  const db = mongoose.connection.db
  if (!db) throw new Error('MongoDB connection has no db object')
  bucket = new GridFSBucket(db, { bucketName: 'sharefiles' })
  logger.info(`[db] MongoDB ${state} and GridFS initialised`)
}

export function isRetryableMongoError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false

  const anyErr = err as { message?: unknown; code?: unknown; name?: unknown; cause?: unknown }
  const message = typeof anyErr.message === 'string' ? anyErr.message : ''
  const name = typeof anyErr.name === 'string' ? anyErr.name : ''
  const code = typeof anyErr.code === 'string' || typeof anyErr.code === 'number' ? String(anyErr.code) : ''

  if (['MongoNetworkError', 'MongoServerSelectionError', 'MongoNotConnectedError'].includes(name)) return true
  if (['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE'].includes(code)) return true

  return /tlsv1 alert internal error|SSL routines|socket hang up|buffering timed out|connection (?:closed|dropped|reset)|topology is closed/i.test(message)
}

export function getBucket(): GridFSBucket {
  if (!bucket) throw new Error('GridFS bucket not initialised — call connectDB first')
  return bucket
}

// ── Expiry timer management ───────────────────────────────────────────────────

// Node-side timer is the SOLE mechanism for deleting sessions and their GridFS
// files. There is NO MongoDB TTL index — that would race against this timer
// and delete the session doc before we can read the gridfsIds from it.
export function scheduleExpiry(code: string, expiresAt: Date): void {
  clearExpiryTimer(code)

  const delayMs = Math.max(0, expiresAt.getTime() - Date.now())

  const timer = setTimeout(async () => {
    expiryTimers.delete(code)
    await deleteSessionAndFiles(code)
  }, delayMs)

  if (timer.unref) timer.unref()

  expiryTimers.set(code, timer)
  logger.debug({ code, delaySec: Math.round(delayMs / 1000) }, '[db] expiry timer set')
}

export function clearExpiryTimer(code: string): void {
  const timer = expiryTimers.get(code)
  if (timer) {
    clearTimeout(timer)
    expiryTimers.delete(code)
  }
}

// Delete GridFS files for the session first, then delete the session document.
// ORDERING IS CRITICAL: always delete GridFS before the session doc.
// If we delete the session doc first and then crash, we lose the gridfsIds
// forever and the GridFS files leak.
export async function deleteSessionAndFiles(code: string): Promise<void> {
  try {
    const session = await StoredSession.findOne({ code }).lean()
    if (!session) {
      logger.info({ code }, '[db] session not found — nothing to delete')
      return
    }

    // Step 1: delete GridFS files (has the ids from the session doc)
    const ids = session.files.map((f) => f.gridfsId)
    if (ids.length > 0) {
      await deleteFiles(ids)
      logger.info({ code, count: ids.length, fileNames: session.files.map(f => f.name) }, '[db] deleted GridFS file(s)')
    }

    // Step 2: delete session document only after GridFS is clean
    await StoredSession.deleteOne({ code })
    logger.info({ code }, '[db] session deleted')
  } catch (err) {
    logger.error({ err, code }, '[db] error deleting session')
  }
}

// On server startup: find all sessions still in DB and either delete them
// (if expired) or reschedule their timers (if still active).
// Uses a cursor to avoid loading all sessions into memory at once.
async function recoverExpiryTimers(): Promise<void> {
  try {
    const now = new Date()
    let recoveredCount = 0
    let expiredCount = 0

    // Fetch documents one by one using a cursor
    const cursor = StoredSession.find({}).cursor()

    for (let s = await cursor.next(); s != null; s = await cursor.next()) {
      if (s.expiresAt <= now) {
        // Expired — delete immediately
        await deleteSessionAndFiles(s.code)
        expiredCount++
      } else {
        // Still active — reschedule
        scheduleExpiry(s.code, s.expiresAt)
        recoveredCount++
      }
    }

    if (expiredCount > 0) logger.info(`[db] recovery: deleted ${expiredCount} expired session(s)`)
    if (recoveredCount > 0) logger.info(`[db] recovery: rescheduled ${recoveredCount} active session timer(s)`)
  } catch (err) {
    logger.error({ err }, '[db] recovery error')
  }
}

// Safety net: find any GridFS files not referenced by any session doc and
// delete them. Also find chunks without parent files.
// MUST NOT run while uploads are in flight — GridFS only creates the .files
// document when the upload finishes, so an active upload looks orphaned.
async function cleanupOrphanedGridFSFiles(): Promise<void> {
  if (activeUploads > 0) {
    logger.debug('[db] skipping orphan-file scan — uploads in flight')
    return
  }
  try {
    const b = getBucket()
    const allFiles = await b.find({}).project({ _id: 1 }).toArray()
    if (allFiles.length === 0) return

    const fileIds = allFiles.map(f => f._id)
    
    // Efficiently find which IDs are NOT referenced in any session.
    // We check in batches of 100 to avoid massive query overhead.
    const BATCH_SIZE = 100
    const orphanIds: ObjectId[] = []

    for (let i = 0; i < fileIds.length; i += BATCH_SIZE) {
      const batch = fileIds.slice(i, i + BATCH_SIZE)
      const referencedDocs = await StoredSession.find({ 
        'files.gridfsId': { $in: batch } 
      }).select('files.gridfsId').lean()

      const referencedIds = new Set(
        referencedDocs.flatMap((doc: any) => doc.files.map((f: any) => f.gridfsId.toString()))
      )

      for (const id of batch) {
        if (!referencedIds.has(id.toString())) {
          orphanIds.push(id as ObjectId)
        }
      }
    }

    if (orphanIds.length > 0) {
      await deleteFiles(orphanIds)
      logger.info({ count: orphanIds.length }, '[db] maintenance: cleaned orphaned GridFS file(s)')
    }
  } catch (err) {
    logger.error({ err }, '[db] orphan file cleanup error')
  }
}

// Deep cleanup: find chunks in .chunks that have no corresponding entry in .files.
// This handles "doubly orphaned" data from crashed uploads or aborted transfers.
// Same in-flight-upload caveat as cleanupOrphanedGridFSFiles().
async function cleanupOrphanedChunks(): Promise<void> {
  if (activeUploads > 0) {
    logger.debug('[db] skipping orphan-chunk scan — uploads in flight')
    return
  }
  try {
    const db = mongoose.connection.db
    if (!db) return

    const filesCol = db.collection('sharefiles.files')
    const chunksCol = db.collection('sharefiles.chunks')

    // Find all unique files_id in chunks
    const chunkFileIds = await chunksCol.distinct('files_id')
    if (chunkFileIds.length === 0) return

    const orphanChunkFileIds: ObjectId[] = []
    
    // Batch check existence in files collection
    const BATCH_SIZE = 100
    for (let i = 0; i < chunkFileIds.length; i += BATCH_SIZE) {
      const batch = chunkFileIds.slice(i, i + BATCH_SIZE)
      const existingFiles = await filesCol.find({ _id: { $in: batch } }).project({ _id: 1 }).toArray()
      const existingIds = new Set(existingFiles.map(f => f._id.toString()))

      for (const id of batch) {
        if (!existingIds.has(id.toString())) {
          orphanChunkFileIds.push(id as ObjectId)
        }
      }
    }

    if (orphanChunkFileIds.length > 0) {
      // Manual chunk deletion for chunks without a file doc (b.delete() requires file doc)
      await chunksCol.deleteMany({ files_id: { $in: orphanChunkFileIds } })
      logger.info({ count: orphanChunkFileIds.length }, '[db] maintenance: cleaned chunks from missing files')
    }
  } catch (err) {
    logger.error({ err }, '[db] orphan chunk cleanup error')
  }
}

async function runMaintenance() {
  if (isMaintenanceRunning) return
  isMaintenanceRunning = true
  try {
    logger.info('[db] starting maintenance scan...')
    const start = Date.now()
    
    await cleanupOrphanedGridFSFiles()
    await cleanupOrphanedChunks()
    await recoverExpiryTimers()
    
    logger.info({ durationMs: Date.now() - start }, '[db] maintenance complete')
  } finally {
    isMaintenanceRunning = false
  }
}

// ── Periodic Maintenance ─────────────────────────────────────────────────────
// Two cadences:
//  • recoverExpiryTimers() every 10 min — cheap cursor scan; deletes expired
//    sessions and reschedules timers lost to a crash. This is the primary
//    defence against unbounded document growth (there is deliberately NO
//    MongoDB TTL index — see schema comment below).
//  • Deep orphan scans hourly + on startup — expensive full-bucket scans;
//    skipped while uploads are in flight to avoid corrupting active uploads.
const RECOVERY_INTERVAL_MS = 10 * 60 * 1000
const DEEP_CLEANUP_INTERVAL_MS = 60 * 60 * 1000

setInterval(() => {
  recoverExpiryTimers().catch(err => logger.error({ err }, '[db] periodic recovery failed'))
}, RECOVERY_INTERVAL_MS).unref()

setInterval(() => {
  runMaintenance().catch(err => logger.error({ err }, '[db] periodic maintenance failed'))
}, DEEP_CLEANUP_INTERVAL_MS).unref()

// ── Stored session schema ─────────────────────────────────────────────────────

export interface IStoredFile {
  name: string
  mimeType: string
  size: number
  gridfsId: ObjectId
  token: string   // Security: random 32-char hex, required in download URL
}

export interface IStoredSession {
  code: string
  text: string
  files:     IStoredFile[]
  expiresAt: Date
  createdAt: Date
  password?: string // Optional hashed password
  burnOnRead?: boolean
  burnedAt?: Date | null // Set on first read of a burn-on-read session; blocks further reads until deletion
}

const storedSessionSchema = new mongoose.Schema<IStoredSession>({
  code:      { type: String, required: true, unique: true, index: true },
  text:      { type: String, default: '' },
  files:     [{
    name:     String,
    mimeType: String,
    size:     Number,
    gridfsId: mongoose.Schema.Types.ObjectId,
    token:    { type: String, required: true },
  }],
  burnOnRead: { type: Boolean, default: false },
  burnedAt:   { type: Date,   default: null },
  // Deletion design (do NOT add a MongoDB TTL index here):
  //   1. scheduleExpiry() Node timer deletes GridFS files, then the doc.
  //   2. recoverExpiryTimers() (startup + every 10 min) deletes anything a
  //      crash left behind and reschedules live timers.
  //   3. cleanupOrphanedGridFSFiles() is the last-resort sweep.
  // A Mongo TTL would delete ONLY the tiny doc — never the GridFS blobs — and
  // by destroying the gridfsIds it turns reclaimable files into leaks.
  expiresAt: { type: Date, required: true, index: true },
  createdAt: { type: Date, default: Date.now },
  password:  { type: String, select: false }, // Don't include by default in queries
})

export const StoredSession = mongoose.model<IStoredSession>('StoredSession', storedSessionSchema)

// ── GridFS helpers ────────────────────────────────────────────────────────────

export async function uploadFile(
  buffer: Buffer,
  filename: string,
  mimeType: string
): Promise<ObjectId> {
  const b = getBucket()
  activeUploads++
  let settled = false
  const release = () => {
    if (!settled) {
      settled = true
      activeUploads--
    }
  }
  return new Promise((resolve, reject) => {
    const uploadStream = b.openUploadStream(filename, {
      metadata: { mimeType },
    })
    const readable = Readable.from(buffer)
    readable.pipe(uploadStream)
    uploadStream.on('finish', () => {
      release()
      resolve(uploadStream.id as ObjectId)
    })
    uploadStream.on('error', (err) => {
      release()
      reject(err)
    })
    // pipe() does not forward source errors to the destination — handle them
    // explicitly or a failed read would leave the promise pending forever.
    readable.on('error', (err) => {
      release()
      try { uploadStream.destroy(err) } catch { /* already destroyed */ }
      reject(err)
    })
  })
}

export async function deleteFiles(ids: ObjectId[]): Promise<void> {
  const b = getBucket()
  await Promise.all(ids.map((id) =>
    b.delete(id).catch((err) => {
      // Only suppress "file not found" errors. Log everything else.
      if (err?.message?.includes('FileNotFound') || err?.code === 'ENOENT') return
      logger.warn({ id, err: err?.message || err }, '[db] non-critical error deleting GridFS file')
    })
  ))
}

export async function getFileStream(id: ObjectId): Promise<{
  stream: ReturnType<GridFSBucket['openDownloadStream']>
  filename: string
  mimeType: string
}> {
  const b = getBucket()
  const files = await b.find({ _id: id }).toArray()
  if (!files.length) throw new Error('File not found in GridFS')
  const meta = files[0]
  const mimeType = (meta.metadata?.mimeType as string | undefined) ?? 'application/octet-stream'
  const stream = b.openDownloadStream(id)
  return { stream, filename: meta.filename, mimeType }
}
