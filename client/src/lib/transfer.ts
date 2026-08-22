import { WebRTCManager } from './webrtc'
import { guessMime } from './mime'

export const CHUNK_SIZE = 64 * 1024
export const MAX_FILE_SIZE = 100 * 1024 * 1024
const BUFFERED_AMOUNT_LOW_THRESHOLD = 256 * 1024

export interface TransferMeta {
  type: 'meta'
  text: string
  files: { name: string; size: number; mimeType: string }[]
  totalChunks: number
}

export interface TransferDone {
  type: 'done'
}

export interface TransferAbort {
  type: 'abort'
  reason: string
}

export interface TransferProgress {
  chunksTotal: number
  chunksDone: number
  bytesTotal: number
  bytesDone: number
  percent: number
  currentFile: string | null
  speed?: number        // bytes/sec
  timeRemaining?: number // seconds
}

export type SendProgressCallback = (progress: TransferProgress) => void
export type ReceiveProgressCallback = (progress: TransferProgress) => void

// Progress callbacks used to fire once per 64KB chunk (~1600 React
// re-renders/sec on a fast link). Throttle to ~10 updates/sec; the final
// update is always forced through.
const PROGRESS_INTERVAL_MS = 100

function makeProgressThrottle(onProgress: (p: TransferProgress) => void) {
  let lastEmit = 0
  return (p: TransferProgress, force = false) => {
    const now = Date.now()
    if (!force && now - lastEmit < PROGRESS_INTERVAL_MS) return
    lastEmit = now
    onProgress(p)
  }
}

// ── Send side ────────────────────────────────────────────────────────────────

export async function sendTransfer(
  rtc: WebRTCManager,
  text: string,
  files: File[],
  onProgress: SendProgressCallback
): Promise<void> {
  for (const f of files) {
    if (f.size > MAX_FILE_SIZE) {
      throw new Error(`"${f.name}" exceeds the 100 MB limit`)
    }
  }

  const fileMetas = files.map((f) => ({
    name: f.name,
    size: f.size,
    mimeType: f.type || 'application/octet-stream',
  }))

  const totalBytes = files.reduce((sum, f) => sum + f.size, 0)
  const totalChunks = files.reduce((sum, f) => sum + Math.ceil(f.size / CHUNK_SIZE), 0)

  const meta: TransferMeta = { type: 'meta', text, files: fileMetas, totalChunks }
  rtc.send(JSON.stringify(meta))

  if (files.length === 0) {
    rtc.send(JSON.stringify({ type: 'done' } satisfies TransferDone))
    onProgress({ chunksTotal: 0, chunksDone: 0, bytesTotal: 0, bytesDone: 0, percent: 100, currentFile: null })
    return
  }

  const dc = rtc.getDataChannel()
  if (!dc) throw new Error('DataChannel not available')

  dc.bufferedAmountLowThreshold = BUFFERED_AMOUNT_LOW_THRESHOLD

  let chunksDone = 0
  let bytesDone = 0
  const startTime = Date.now()
  const emitProgress = makeProgressThrottle(onProgress)

  const buildProgress = (currentFile: string | null): TransferProgress => {
    const elapsedSec = (Date.now() - startTime) / 1000
    const speed = elapsedSec > 0 ? bytesDone / elapsedSec : 0
    const remainingBytes = totalBytes - bytesDone
    const timeRemaining = speed > 0 ? remainingBytes / speed : 0
    return {
      chunksTotal: totalChunks,
      chunksDone,
      bytesTotal: totalBytes,
      bytesDone,
      percent: totalBytes > 0 ? Math.round((bytesDone / totalBytes) * 100) : 100,
      currentFile,
      speed,
      timeRemaining,
    }
  }

  try {
    for (const file of files) {
      let offset = 0
      while (offset < file.size) {

        // FIX 5: Check channel is still open before each send.
        // If reset() was called, the channel is closed — abort cleanly.
        if (dc.readyState !== 'open') {
          throw new Error('DataChannel closed — transfer cancelled')
        }

        const slice = file.slice(offset, offset + CHUNK_SIZE)
        const buffer = await slice.arrayBuffer()

        if (dc.bufferedAmount > BUFFERED_AMOUNT_LOW_THRESHOLD) {
          // FIX 3: waitForBufferDrain now rejects if channel closes while waiting
          await waitForBufferDrain(dc)
        }

        // Check again after async wait — channel may have closed during drain
        if (dc.readyState !== 'open') {
          throw new Error('DataChannel closed during buffer drain')
        }

        rtc.send(buffer)
        chunksDone++
        bytesDone += buffer.byteLength
        offset += buffer.byteLength

        emitProgress(buildProgress(file.name))
      }
    }

    rtc.send(JSON.stringify({ type: 'done' } satisfies TransferDone))
    // Force the final progress state through so the UI lands at 100%.
    emitProgress(buildProgress(files[files.length - 1]?.name ?? null), true)

  } catch (err) {
    // FIX 6: Send abort message to recipient so they don't wait forever.
    // Best-effort — the channel may already be closed, that's OK.
    const reason = err instanceof Error ? err.message : 'Unknown error'
    try {
      if (dc.readyState === 'open') {
        rtc.send(JSON.stringify({ type: 'abort', reason } satisfies TransferAbort))
      }
    } catch {
      // Channel already closed — FIX 4 (channel close event) handles recipient side
    }
    throw err // Re-throw so caller can log and update UI
  }
}

// FIX 3: waitForBufferDrain rejects if DataChannel closes while waiting.
// Previously this was a Promise that never resolved on channel close,
// hanging sendTransfer forever.
function waitForBufferDrain(dc: RTCDataChannel): Promise<void> {
  return new Promise((resolve, reject) => {
    const onDrain = () => {
      cleanup()
      resolve()
    }
    const onClose = () => {
      cleanup()
      reject(new Error('DataChannel closed while waiting for buffer drain'))
    }
    const onError = () => {
      cleanup()
      reject(new Error('DataChannel error while waiting for buffer drain'))
    }

    function cleanup() {
      dc.removeEventListener('bufferedamountlow', onDrain)
      dc.removeEventListener('close', onClose)
      dc.removeEventListener('error', onError)
    }

    dc.addEventListener('bufferedamountlow', onDrain)
    dc.addEventListener('close', onClose)
    dc.addEventListener('error', onError)
  })
}

// ── Receive side ─────────────────────────────────────────────────────────────

export interface ReceivedFile {
  name: string
  mimeType: string
  blob: Blob
}

export interface ReceivedTransfer {
  text: string
  files: ReceivedFile[]
}

export class TransferReceiver {
  private meta: TransferMeta | null = null
  private fileChunks: ArrayBuffer[][] = []
  private fileBytesDone: number[] = []
  private currentFileIndex = 0
  private totalBytesDone = 0
  private totalChunksDone = 0
  private finalized = false  // Prevent double-complete
  private onComplete: (result: ReceivedTransfer) => void
  private onAbort: (reason: string) => void
  private inactivityTimer: ReturnType<typeof setTimeout> | null = null
  private startTime = 0
  private emitProgress: (p: TransferProgress, force?: boolean) => void

  constructor(
    onProgress: ReceiveProgressCallback,
    onComplete: (result: ReceivedTransfer) => void,
    onAbort: (reason: string) => void   // FIX 4+6: called on abort or channel close
  ) {
    this.onComplete = onComplete
    this.onAbort = onAbort
    this.emitProgress = makeProgressThrottle(onProgress)
  }

  receive(data: string | ArrayBuffer): void {
    if (typeof data === 'string') {
      this.handleJSON(data)
    } else {
      this.handleChunk(data)
    }
  }

  // FIX 4: Called when the DataChannel closes mid-transfer.
  // If a transfer was in progress, notify the recipient it was aborted.
  abort(reason: string): void {
    this.clearInactivityTimer()
    if (this.finalized) return
    if (!this.meta) return // No transfer was in progress — no-op

    this.finalized = true
    this.onAbort(reason)
    this.reset()
  }

  private clearInactivityTimer(): void {
    if (this.inactivityTimer) {
      clearTimeout(this.inactivityTimer)
      this.inactivityTimer = null
    }
  }

  // FIX 9: Inactivity timeout — if publisher crashes after meta but before all chunks.
  // Set a 30s timeout when meta is received. Reset on each chunk. Abort if timeout fires.
  private resetInactivityTimer(): void {
    this.clearInactivityTimer()
    
    this.inactivityTimer = setTimeout(() => {
      if (!this.finalized && this.meta && this.totalChunksDone < this.meta.totalChunks) {
        this.abort(`No data received for 30 seconds — publisher may have disconnected`)
      }
    }, 30000)
  }

  private handleJSON(raw: string): void {
    let msg: TransferMeta | TransferDone | TransferAbort
    try {
      msg = JSON.parse(raw)
    } catch {
      return
    }

    if (msg.type === 'meta') {
      this.meta = msg
      this.fileChunks = msg.files.map(() => [])
      this.fileBytesDone = msg.files.map(() => 0)
      this.currentFileIndex = 0
      this.totalBytesDone = 0
      this.totalChunksDone = 0
      this.finalized = false
      this.startTime = Date.now()
      // Zero-byte files never receive chunks — skip over them up front
      // (and after each boundary advance below), otherwise every subsequent
      // chunk would be mis-attributed to the empty file.
      while (
        this.currentFileIndex < msg.files.length &&
        msg.files[this.currentFileIndex].size === 0
      ) {
        this.currentFileIndex++
      }
      this.resetInactivityTimer()  // Start timeout when metadata arrives
    }

    if (msg.type === 'done') {
      this.finalize()
    }

    // FIX 6: Publisher explicitly aborted the transfer
    if (msg.type === 'abort') {
      const reason = (msg as TransferAbort).reason ?? 'Transfer aborted by sender'
      this.abort(reason)
    }
  }

  private handleChunk(buffer: ArrayBuffer): void {
    if (!this.meta || this.finalized) return
    const files = this.meta.files
    if (this.currentFileIndex >= files.length) return

    // Reset inactivity timer on each chunk received
    this.resetInactivityTimer()

    const idx = this.currentFileIndex
    const remaining = files[idx].size - this.fileBytesDone[idx]
    if (remaining <= 0 && files[idx].size > 0) return

    // A chunk can span a file boundary (sender streams contiguously).
    // Split it so bytes always land in the file they belong to.
    const take = Math.min(remaining, buffer.byteLength)
    if (take > 0) {
      this.fileChunks[idx].push(buffer.slice(0, take))
      this.fileBytesDone[idx] += take
      this.totalBytesDone += take
      this.totalChunksDone++
    }
    let rest: ArrayBuffer | null = take < buffer.byteLength ? buffer.slice(take) : null

    while (this.currentFileIndex < files.length &&
           this.fileBytesDone[this.currentFileIndex] >= files[this.currentFileIndex].size &&
           files[this.currentFileIndex].size > 0) {
      this.currentFileIndex++
    }
    // Skip any zero-byte files at the new boundary
    while (this.currentFileIndex < files.length && files[this.currentFileIndex].size === 0) {
      this.currentFileIndex++
    }

    // Spill leftover bytes into the following file(s)
    while (rest && rest.byteLength > 0 && this.currentFileIndex < files.length) {
      const nextIdx = this.currentFileIndex
      const nextRemaining = files[nextIdx].size - this.fileBytesDone[nextIdx]
      if (nextRemaining <= 0 && files[nextIdx].size > 0) { this.currentFileIndex++; continue }
      const nextTake = Math.min(Math.max(nextRemaining, 0), rest.byteLength)
      if (nextTake > 0) {
        this.fileChunks[nextIdx].push(rest.slice(0, nextTake))
        this.fileBytesDone[nextIdx] += nextTake
        this.totalBytesDone += nextTake
        this.totalChunksDone++
      }
      rest = nextTake < rest.byteLength ? rest.slice(nextTake) : null
      while (this.currentFileIndex < files.length &&
             this.fileBytesDone[this.currentFileIndex] >= files[this.currentFileIndex].size &&
             files[this.currentFileIndex].size > 0) {
        this.currentFileIndex++
      }
      while (this.currentFileIndex < files.length && files[this.currentFileIndex].size === 0) {
        this.currentFileIndex++
      }
    }

    const totalBytes = files.reduce((s, f) => s + f.size, 0)
    const percent = totalBytes > 0 ? Math.round((this.totalBytesDone / totalBytes) * 100) : 100
    const currentFileName = files[Math.min(this.currentFileIndex, files.length - 1)]?.name ?? null

    const elapsedSec = (Date.now() - this.startTime) / 1000
    const speed = elapsedSec > 0 ? this.totalBytesDone / elapsedSec : 0
    const remainingBytes = totalBytes - this.totalBytesDone
    const timeRemaining = speed > 0 ? remainingBytes / speed : 0

    this.emitProgress({
      chunksTotal: this.meta.totalChunks,
      chunksDone: this.totalChunksDone,
      bytesTotal: totalBytes,
      bytesDone: this.totalBytesDone,
      percent,
      currentFile: currentFileName,
      speed,
      timeRemaining,
    })
  }

  private finalize(): void {
    this.clearInactivityTimer()
    if (!this.meta || this.finalized) return
    this.finalized = true

    // Verify every file received exactly the byte count the sender declared.
    // RTCDataChannel ordered:true makes drift practically impossible, but a
    // buggy sender (or a mid-transfer abort we missed) must not surface as a
    // silently corrupted download — fail loudly instead of completing.
    const mismatches = this.meta.files
      .map((fileMeta, i) => ({ name: fileMeta.name, expected: fileMeta.size, got: this.fileBytesDone[i] }))
      .filter(m => m.expected !== m.got)

    if (mismatches.length > 0) {
      const first = mismatches[0]
      this.onAbort(`Corrupted transfer: "${first.name}" received ${first.got} of ${first.expected} bytes`)
      this.reset()
      return
    }

    const receivedFiles: ReceivedFile[] = this.meta.files.map((fileMeta, i) => ({
      name: fileMeta.name,
      mimeType: guessMime(fileMeta.name, fileMeta.mimeType),
      blob: new Blob(this.fileChunks[i], { type: guessMime(fileMeta.name, fileMeta.mimeType) }),
    }))

    const result: ReceivedTransfer = { text: this.meta.text, files: receivedFiles }
    this.onComplete(result)
    this.reset()
  }

  private reset(): void {
    this.meta = null
    this.fileChunks = []
    this.fileBytesDone = []
    this.currentFileIndex = 0
    this.totalBytesDone = 0
    this.totalChunksDone = 0
  }
}
