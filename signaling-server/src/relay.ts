import { WebSocket } from 'ws'
import { IncomingMessage } from 'http'
import { SignalMessage, JoinPayload, PeerRole } from './types'
import { getSession, addPeer, removePeer, sendTo } from './sessionManager'

const RELAY_TYPES = new Set(['offer', 'answer', 'ice'])

// FIX 1: Maximum WebSocket message size before JSON.parse.
// Valid signaling messages are tiny (SDP ~10KB, ICE ~500B, join ~100B).
// A 64KB cap stops malicious large messages from blocking the event loop.
const MAX_WS_MSG_BYTES = 64 * 1024 // 64 KB

// FIX 10: WebSocket message rate limiting per connection.
// Prevents a malicious actor from flooding the relay with offer/answer/ICE.
// Limit: 100 messages per minute per connection.
const RATE_LIMIT_WINDOW_MS = 60 * 1000  // 1 minute
const RATE_LIMIT_MAX_MSGS   = 100

interface PeerContext {
  code: string | null
  role: PeerRole | null
  peerId: string | null
}

export function handleConnection(ws: WebSocket, _req: IncomingMessage): void {
  const ctx: PeerContext = { code: null, role: null, peerId: null };

  // Heartbeat: mark as alive on pong
  (ws as any).isAlive = true
  ws.on('pong', () => {
    (ws as any).isAlive = true
  })

  // Rate limiting: track message count per window
  let messageCount = 0
  let windowStart = Date.now()

  ws.on('message', (raw) => {
    // FIX 10: Rate limit messages per connection
    const now = Date.now()
    if (now - windowStart > RATE_LIMIT_WINDOW_MS) {
      messageCount = 0
      windowStart = now
    }
    messageCount++
    
    if (messageCount > RATE_LIMIT_MAX_MSGS) {
      console.warn(`[relay] rate limit exceeded (${messageCount} msg/min) — closing connection`)
      ws.close(1008, 'Rate limit exceeded')
      return
    }
    // FIX 1: Reject oversized messages before JSON.parse
    const msgLength = Buffer.isBuffer(raw) ? raw.length : Buffer.byteLength(raw.toString())
    if (msgLength > MAX_WS_MSG_BYTES) {
      console.warn(`[relay] oversized message (${msgLength} bytes) — closing connection`)
      ws.close(1009, 'Message too large')
      return
    }

    let msg: SignalMessage
    try {
      msg = JSON.parse(raw.toString()) as SignalMessage
    } catch {
      sendTo(ws, { type: 'error', payload: 'Invalid JSON' })
      return
    }

    if (msg.type === 'join') {
      handleJoin(ws, ctx, msg.payload as JoinPayload)
      return
    }

    if (!ctx.code || !ctx.role || !ctx.peerId) {
      sendTo(ws, { type: 'error', payload: 'Send join first' })
      return
    }

    if (RELAY_TYPES.has(msg.type)) {
      handleRelay(ws, ctx, msg)
      return
    }

    sendTo(ws, { type: 'error', payload: `Unknown type: ${msg.type}` })
  })

  ws.on('close', () => {
    if (ctx.code && ctx.role && ctx.peerId) {
      removePeer(ctx.code, ctx.peerId, ctx.role)
    }
  })

  ws.on('error', (err) => console.error('[relay] ws error:', err.message))
}

function handleJoin(ws: WebSocket, ctx: PeerContext, payload: JoinPayload): void {
  if (!payload?.code || !payload?.role) {
    sendTo(ws, { type: 'error', payload: 'join requires { code, role }' })
    return
  }

  const { code, role } = payload

  if (role !== 'publisher' && role !== 'recipient') {
    sendTo(ws, { type: 'error', payload: 'role must be publisher or recipient' })
    return
  }

  if (!/^\d{6}$/.test(code)) {
    sendTo(ws, { type: 'error', payload: 'code must be 6 digits' })
    return
  }

  const session = getSession(code)
  if (!session) {
    sendTo(ws, { type: 'error', payload: 'Session not found or expired' })
    return
  }

  const result = addPeer(code, role, ws)
  if (!result) {
    if (role === 'publisher') {
      sendTo(ws, { type: 'error', payload: 'A publisher is already in this session' })
    } else {
      // FIX 2: recipient limit reached
      sendTo(ws, { type: 'error', payload: 'Session is full — maximum recipients reached' })
    }
    return
  }

  ctx.code = code
  ctx.role = role
  ctx.peerId = result.peer.id

  if (role === 'publisher') {
    const waitingRecipients = Array.from(result.session.recipients.values())
    if (waitingRecipients.length > 0) {
      for (const recipient of waitingRecipients) {
        sendTo(ws, { type: 'ready', peerId: recipient.id })
        sendTo(recipient.ws, { type: 'ready', peerId: recipient.id })
        console.log(`[relay] ready (late publisher): publisher ↔ recipient ${recipient.id.slice(0, 8)} in ${code}`)
      }
    } else {
      console.log(`[relay] publisher joined ${code} — waiting for recipients`)
    }

  } else {
    if (result.session.publisher) {
      const recipientId = result.peer.id
      sendTo(result.session.publisher.ws, { type: 'ready', peerId: recipientId })
      sendTo(ws, { type: 'ready', peerId: recipientId })
      console.log(`[relay] ready: publisher ↔ recipient ${recipientId.slice(0, 8)} in ${code}`)
    } else {
      console.log(`[relay] recipient ${result.peer.id.slice(0, 8)} waiting for publisher in ${code}`)
      sendTo(ws, { type: 'error', payload: 'Waiting for publisher — please wait' })
    }
  }
}

function handleRelay(ws: WebSocket, ctx: PeerContext, msg: SignalMessage): void {
  const session = getSession(ctx.code!)
  if (!session) {
    sendTo(ws, { type: 'error', payload: 'Session not found' })
    return
  }

  if (ctx.role === 'publisher') {
    const targetId = msg.peerId
    if (!targetId) {
      sendTo(ws, { type: 'error', payload: 'peerId required from publisher' })
      return
    }
    const recipient = session.recipients.get(targetId)
    if (!recipient) {
      sendTo(ws, { type: 'error', payload: 'Recipient not found' })
      return
    }
    sendTo(recipient.ws, msg)
  } else {
    if (!session.publisher) {
      sendTo(ws, { type: 'error', payload: 'Publisher not connected' })
      return
    }
    sendTo(session.publisher.ws, { ...msg, peerId: ctx.peerId! })
  }
}
