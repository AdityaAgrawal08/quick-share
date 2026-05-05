import { WebRTCManager } from './webrtc'

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

        const elapsedSec = (Date.now() - startTime) / 1000
        const speed = elapsedSec > 0 ? bytesDone / elapsedSec : 0
        const remainingBytes = totalBytes - bytesDone
        const timeRemaining = speed > 0 ? remainingBytes / speed : 0

        onProgress({
          chunksTotal: totalChunks,
          chunksDone,
          bytesTotal: totalBytes,
          bytesDone,
          percent: Math.round((bytesDone / totalBytes) * 100),
          currentFile: file.name,
          speed,
          timeRemaining,
        })
      }
    }

    rtc.send(JSON.stringify({ type: 'done' } satisfies TransferDone))

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
  private onProgress: ReceiveProgressCallback
  private onComplete: (result: ReceivedTransfer) => void
  private onAbort: (reason: string) => void
  private inactivityTimer: ReturnType<typeof setTimeout> | null = null
  private lastChunkTime = 0
  private startTime = 0

  constructor(
    onProgress: ReceiveProgressCallback,
    onComplete: (result: ReceivedTransfer) => void,
    onAbort: (reason: string) => void   // FIX 4+6: called on abort or channel close
  ) {
    this.onProgress = onProgress
    this.onComplete = onComplete
    this.onAbort = onAbort
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
    console.log('[transfer] aborted:', reason)
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
    this.lastChunkTime = Date.now()
    
    this.inactivityTimer = setTimeout(() => {
      if (!this.finalized && this.meta && this.totalChunksDone < this.meta.totalChunks) {
        const elapsed = Date.now() - this.lastChunkTime
        console.warn(`[transfer] inactivity timeout — no chunks for ${elapsed}ms`)
        this.abort(`No data received for 30 seconds — publisher may have disconnected`)
      }
    }, 30000)
  }

  private handleJSON(raw: string): void {
    let msg: TransferMeta | TransferDone | TransferAbort
    try {
      msg = JSON.parse(raw)
    } catch {
      console.error('[transfer] invalid JSON:', raw)
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
      this.resetInactivityTimer()  // Start timeout when metadata arrives
      console.log('[transfer] meta received:', msg.files.map((f) => f.name))
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

    this.fileChunks[this.currentFileIndex].push(buffer)
    this.fileBytesDone[this.currentFileIndex] += buffer.byteLength
    this.totalBytesDone += buffer.byteLength
    this.totalChunksDone++

    if (this.fileBytesDone[this.currentFileIndex] >= files[this.currentFileIndex].size) {
      this.currentFileIndex++
    }

    const totalBytes = files.reduce((s, f) => s + f.size, 0)
    const percent = totalBytes > 0 ? Math.round((this.totalBytesDone / totalBytes) * 100) : 100
    const currentFileName = files[Math.min(this.currentFileIndex, files.length - 1)]?.name ?? null

    const elapsedSec = (Date.now() - this.startTime) / 1000
    const speed = elapsedSec > 0 ? this.totalBytesDone / elapsedSec : 0
    const remainingBytes = totalBytes - this.totalBytesDone
    const timeRemaining = speed > 0 ? remainingBytes / speed : 0

    this.onProgress({
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

    // FIX 8: Verify chunk count matches what sender declared in meta.
    // RTCDataChannel ordered:true makes mismatch practically impossible,
    // but a malicious or buggy sender could declare wrong totalChunks.
    // We warn but still complete — aborting would discard data that did arrive.
    if (this.totalChunksDone !== this.meta.totalChunks) {
      console.warn(
        `[transfer] chunk count mismatch: received ${this.totalChunksDone}, expected ${this.meta.totalChunks}`
      )
    }

    const receivedFiles: ReceivedFile[] = this.meta.files.map((fileMeta, i) => ({
      name: fileMeta.name,
      mimeType: fileMeta.mimeType,
      blob: new Blob(this.fileChunks[i], { type: fileMeta.mimeType }),
    }))

    const result: ReceivedTransfer = { text: this.meta.text, files: receivedFiles }
    console.log('[transfer] complete:', receivedFiles.map((f) => f.name))
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
