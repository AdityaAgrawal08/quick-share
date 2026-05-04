import type { SignalMessage, PeerRole } from '../types'

type MessageHandler = (msg: SignalMessage) => void

interface SignalingClientOptions {
  serverUrl: string
  code: string
  role: PeerRole
  onMessage: MessageHandler
  onOpen?: () => void
  onClose?: () => void
  onError?: (err: Event) => void
  onReconnecting?: (attempt: number, maxAttempts: number) => void
  onReconnectFailed?: () => void
}

const RECONNECT_BASE_MS  = 1000   // 1s initial delay
const RECONNECT_MAX_MS   = 30000  // 30s max delay
const RECONNECT_MAX_ATTEMPTS = 5

export class SignalingClient {
  private ws: WebSocket | null = null
  private opts: SignalingClientOptions
  private intentionalClose = false   // set by disconnect() — no reconnect
  private reconnectAttempt = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null

  constructor(opts: SignalingClientOptions) {
    this.opts = opts
  }

  connect(): void {
    this.intentionalClose = false
    this.reconnectAttempt = 0
    this.openSocket()
  }

  private openSocket(): void {
    const ws = new WebSocket(this.opts.serverUrl)
    this.ws = ws

    ws.onopen = () => {
      this.reconnectAttempt = 0  // Reset on successful connect
      // Re-send join on every (re)connect — server needs it to rebuild ctx
      this.send({ type: 'join', payload: { code: this.opts.code, role: this.opts.role } })
      this.opts.onOpen?.()
    }

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data as string) as SignalMessage
        this.opts.onMessage(msg)
      } catch {
        console.error('[signaling] failed to parse message:', event.data)
      }
    }

    ws.onclose = (_event) => {
      this.ws = null

      if (this.intentionalClose) {
        // Clean intentional close — notify and stop
        this.opts.onClose?.()
        return
      }

      // Transient drop — attempt reconnect without firing onClose
      // (avoids "WS closed" log spam on every retry attempt)
      this.scheduleReconnect()
    }

    ws.onerror = (err) => {
      console.error('[signaling] ws error', err)
      this.opts.onError?.(err)
      // onclose fires after onerror — reconnect logic lives there
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectAttempt >= RECONNECT_MAX_ATTEMPTS) {
      console.warn('[signaling] max reconnect attempts reached')
      this.opts.onClose?.()         // Fire onClose only when truly giving up
      this.opts.onReconnectFailed?.()
      return
    }

    // Exponential backoff + jitter to avoid thundering herd
    const exp   = Math.min(RECONNECT_BASE_MS * Math.pow(2, this.reconnectAttempt), RECONNECT_MAX_MS)
    const jitter = Math.random() * 500
    const delay  = Math.round(exp + jitter)

    this.reconnectAttempt++
    console.log(`[signaling] reconnecting in ${delay}ms (attempt ${this.reconnectAttempt}/${RECONNECT_MAX_ATTEMPTS})`)
    this.opts.onReconnecting?.(this.reconnectAttempt, RECONNECT_MAX_ATTEMPTS)

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.openSocket()
    }, delay)
  }

  send(msg: SignalMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg))
    } else {
      console.warn('[signaling] attempted send on non-open socket', msg.type)
    }
  }

  disconnect(): void {
    this.intentionalClose = true
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.ws?.close(1000, 'Client disconnected')
    this.ws = null
  }
}
