import { WebSocket } from 'ws'
import { IncomingMessage } from 'http'
import { SignalMessage, JoinPayload, PeerRole } from './types'
import { getSession, addPeer, removePeer, sendTo } from './sessionManager'
import logger from './logger'
import crypto from 'crypto'
import { promisify } from 'util'

const scrypt = promisify(crypto.scrypt)

async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [salt, key] = stored.split(':')
  const derivedKey = (await scrypt(password, salt, 64)) as Buffer
  return derivedKey.toString('hex') === key
}

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

// Brute-force protection for WebSocket passwords
const FAILED_ATTEMPTS_LIMIT = 10
const FAILED_ATTEMPTS_WINDOW = 15 * 60 * 1000 // 15 minutes
const failedAttempts = new Map<string, { count: number, resetAt: number }>()

function isBruteForcing(ip: string): boolean {
  const record = failedAttempts.get(ip)
  if (!record) return false
  if (Date.now() > record.resetAt) {
    failedAttempts.delete(ip)
    return false
  }
  return record.count >= FAILED_ATTEMPTS_LIMIT
}

function recordFailure(ip: string) {
  const record = failedAttempts.get(ip) || { count: 0, resetAt: Date.now() + FAILED_ATTEMPTS_WINDOW }
  record.count++
  failedAttempts.set(ip, record)
}

interface PeerContext {
  code: string | null
  role: PeerRole | null
  peerId: string | null
}

export function handleConnection(ws: WebSocket, _req: IncomingMessage): void {
  const ctx: PeerContext = { code: null, role: null, peerId: null };
  (ws as any)._ip = _req.socket.remoteAddress;

  // Heartbeat: mark as alive on pong
  (ws as any).isAlive = true
  ws.on('pong', () => {
    (ws as any).isAlive = true
  })

  // Rate limiting: track message count per window
  let messageCount = 0
  let windowStart = Date.now()

  ws.on('message', async (raw) => {
    // FIX 10: Rate limit messages per connection
    const now = Date.now()
    if (now - windowStart > RATE_LIMIT_WINDOW_MS) {
      messageCount = 0
      windowStart = now
    }
    messageCount++
    
    if (messageCount > RATE_LIMIT_MAX_MSGS) {
      logger.warn({ ip: _req.socket.remoteAddress }, 'WebSocket: rate limit exceeded')
      ws.close(1008, 'Rate limit exceeded')
      return
    }
    // FIX 1: Reject oversized messages before JSON.parse
    const msgLength = Buffer.isBuffer(raw) ? raw.length : Buffer.byteLength(raw.toString())
    if (msgLength > 65536) {
      logger.warn({ ip: _req.socket.remoteAddress }, 'WebSocket: oversized message rejected')
      ws.close(1009, 'Message too large')
      return
    }

    let msg: SignalMessage
    try {
      msg = JSON.parse(raw.toString()) as SignalMessage
    } catch (err) {
      logger.error({ err, raw }, 'WebSocket: parse error')
      ws.close(1003, 'Invalid JSON')
      return
    }

    if (msg.type === 'join') {
      await handleJoin(ws, ctx, msg.payload as any)
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
      logger.info({ code: ctx.code, peerId: ctx.peerId }, 'WebSocket: peer disconnected')
    }
  })

  ws.on('error', (err) => logger.error({ err }, 'WebSocket: ws error'))
}

async function handleJoin(ws: WebSocket, ctx: PeerContext, payload: JoinPayload): Promise<void> {
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

  // Mandatory password check for recipients
  if (role === 'recipient') {
    const ip = (ws as any)._ip || 'unknown'
    if (isBruteForcing(ip)) {
      sendTo(ws, { type: 'error', payload: 'Too many failed attempts. Try again in 15 minutes.' })
      return
    }

    const providedPass = (payload as any).password
    if (!providedPass || !(await verifyPassword(providedPass, session.passwordHash || ''))) {
      recordFailure(ip)
      // Artificial delay to slow down automated brute force
      await new Promise(r => setTimeout(r, 500 + Math.random() * 1000))
      sendTo(ws, { type: 'error', payload: 'invalid_password' })
      return
    }
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
  logger.info({ code, peerId: ctx.peerId, role }, 'WebSocket: peer joined')

  if (role === 'publisher') {
    const waitingRecipients = Array.from(result.session.recipients.values())
    if (waitingRecipients.length > 0) {
      for (const recipient of waitingRecipients) {
        sendTo(ws, { type: 'ready', peerId: recipient.id })
        sendTo(recipient.ws, { type: 'ready', peerId: recipient.id })
        logger.info({ code, peerId: recipient.id }, 'WebSocket: ready (late publisher)')
      }
    } else {
      logger.info({ code }, 'WebSocket: publisher joined — waiting for recipients')
    }

  } else {
    if (result.session.publisher) {
      const recipientId = result.peer.id
      sendTo(result.session.publisher.ws, { type: 'ready', peerId: recipientId })
      sendTo(ws, { type: 'ready', peerId: recipientId })
      logger.info({ code, peerId: recipientId }, 'WebSocket: ready: publisher ↔ recipient')
    } else {
      logger.info({ code, peerId: result.peer.id }, 'WebSocket: recipient waiting for publisher')
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
