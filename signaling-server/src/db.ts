import mongoose from 'mongoose'
import { GridFSBucket, ObjectId } from 'mongodb'
import { Readable } from 'stream'

let bucket: GridFSBucket | null = null

// In-memory map of active expiry timers: code → NodeJS.Timeout
const expiryTimers = new Map<string, ReturnType<typeof setTimeout>>()

// ── Connection ────────────────────────────────────────────────────────────────

export async function connectDB(): Promise<void> {
  const uri = process.env.MONGODB_URI
  if (!uri) throw new Error('MONGODB_URI not set in environment')

  await mongoose.connect(uri)
  const db = mongoose.connection.db
  if (!db) throw new Error('MongoDB connection has no db object')
  bucket = new GridFSBucket(db, { bucketName: 'sharefiles' })
  console.log('[db] MongoDB connected')

  // On startup: recover timers and clean up any orphaned data from a
  // previous server crash. Order matters: orphan scan first, then timers.
  await cleanupOrphanedGridFSFiles()
  await recoverExpiryTimers()
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
  console.log(`[db] expiry timer set for ${code} in ${Math.round(delayMs / 1000)}s`)
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
      console.log(`[db] session ${code} not found — nothing to delete`)
      return
    }

    // Step 1: delete GridFS files (has the ids from the session doc)
    const ids = session.files.map((f) => f.gridfsId)
    if (ids.length > 0) {
      await deleteFiles(ids)
      console.log(`[db] deleted ${ids.length} GridFS file(s) for session ${code}`)
    }

    // Step 2: delete session document only after GridFS is clean
    await StoredSession.deleteOne({ code })
    console.log(`[db] session ${code} deleted`)
  } catch (err) {
    console.error(`[db] error deleting session ${code}:`, err)
  }
}

// On server startup: find all sessions still in DB and either delete them
// (if expired) or reschedule their timers (if still active).
// Because there is no MongoDB TTL, expired sessions accumulate in DB until
// the server restarts — this function handles all of them.
async function recoverExpiryTimers(): Promise<void> {
  try {
    // Fetch full documents (need files[].gridfsId for immediate deletion)
    const sessions = await StoredSession.find({}).lean()
    if (sessions.length === 0) return

    const now = Date.now()
    const expired: typeof sessions = []
    const active:  typeof sessions = []

    for (const s of sessions) {
      if (s.expiresAt.getTime() - now <= 0) expired.push(s)
      else active.push(s)
    }

    // FIX 6: Delete expired sessions in parallel — each session is independent
    if (expired.length > 0) {
      await Promise.all(expired.map((s) => deleteSessionAndFiles(s.code)))
      console.log(`[db] recovery: deleted ${expired.length} expired session(s)`)
    }

    // Reschedule active session timers (synchronous — just sets setTimeout)
    for (const s of active) {
      scheduleExpiry(s.code, s.expiresAt)
    }
    if (active.length > 0) console.log(`[db] recovery: rescheduled ${active.length} active session timer(s)`)
  } catch (err) {
    console.error('[db] recovery error:', err)
  }
}

// Safety net: find any GridFS files not referenced by any session doc and
// delete them. This catches the edge case where a previous server run died
// after deleting the session doc but before finishing GridFS deletion.
async function cleanupOrphanedGridFSFiles(): Promise<void> {
  try {
    const b = getBucket()

    const gridfsFiles = await b.find({}).toArray()
    if (gridfsFiles.length === 0) return

    const allGridfsIds = gridfsFiles.map((f) => f._id as ObjectId)

    // Find all gridfsIds still referenced by a session doc
    const liveSessions = await StoredSession.find(
      { 'files.gridfsId': { $in: allGridfsIds } },
      { 'files.gridfsId': 1 }
    ).lean()

    const referencedIds = new Set(
      liveSessions.flatMap((s) => s.files.map((f) => f.gridfsId.toString()))
    )

    const orphaned = allGridfsIds.filter((id) => !referencedIds.has(id.toString()))

    if (orphaned.length > 0) {
      await deleteFiles(orphaned)
      console.log(`[db] startup: cleaned ${orphaned.length} orphaned GridFS file(s)`)
    }
  } catch (err) {
    console.error('[db] orphan cleanup error:', err)
  }
}

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
  files: IStoredFile[]
  expiresAt: Date
  createdAt: Date
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
  // NO expires: 0 here — MongoDB TTL is intentionally removed.
  // If MongoDB TTL deletes the session doc before our Node timer fires,
  // we lose the gridfsIds and GridFS files leak permanently.
  // The Node timer in scheduleExpiry() handles all deletion.
  expiresAt: { type: Date, required: true },
  createdAt: { type: Date, default: Date.now },
})

export const StoredSession = mongoose.model<IStoredSession>('StoredSession', storedSessionSchema)

// ── GridFS helpers ────────────────────────────────────────────────────────────

export async function uploadFile(
  buffer: Buffer,
  filename: string,
  mimeType: string
): Promise<ObjectId> {
  const b = getBucket()
  return new Promise((resolve, reject) => {
    const uploadStream = b.openUploadStream(filename, {
      metadata: { mimeType },
    })
    const readable = Readable.from(buffer)
    readable.pipe(uploadStream)
    uploadStream.on('finish', () => resolve(uploadStream.id as ObjectId))
    uploadStream.on('error', reject)
  })
}

export async function deleteFiles(ids: ObjectId[]): Promise<void> {
  const b = getBucket()
  await Promise.all(ids.map((id) =>
    b.delete(id).catch(() => { /* already deleted — ignore */ })
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
