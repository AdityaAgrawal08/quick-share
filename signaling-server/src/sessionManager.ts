import { WebSocket } from 'ws'
import { Session, Peer, PeerRole, SignalMessage } from './types'
import { randomInt, randomUUID } from 'crypto'
import logger from './logger'

const sessions = new Map<string, Session>()
const CODE_LENGTH = 6
const MAX_ATTEMPTS = 20

// FIX 7: Idle timeout — destroy sessions where publisher never joins.
// Prevents no-publisher sessions from consuming memory for the full TTL.
const IDLE_TIMEOUT_MS = 5 * 60 * 1000 // 5 minutes

// FIX 2: Maximum recipients allowed per live session.
// Prevents a malicious actor from forcing the publisher to open
// thousands of RTCPeerConnections simultaneously (DoS / OOM).
const MAX_RECIPIENTS_PER_SESSION = 50

function generateCode(): string {
  return randomInt(0, 1_000_000).toString().padStart(CODE_LENGTH, '0')
}

function generateUniqueCode(): string {
  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    const code = generateCode()
    if (!sessions.has(code)) return code
  }
  throw new Error('Failed to generate unique session code')
}

export function createSession(ttlMs: number, passwordHash?: string): string {
  const code = generateUniqueCode()

  const timer = setTimeout(() => expireSession(code), ttlMs)
  if (timer.unref) timer.unref()

  // FIX 7: idle timer — fires if publisher never connects
  const idleTimer = setTimeout(() => {
    const s = sessions.get(code)
    if (s && !s.publisher) {
      console.log(`[session] idle timeout — no publisher joined ${code}`)
      // Clear ttlTimer too — session is being destroyed here
      clearTimeout(s.ttlTimer)
      // Notify any waiting recipients
      s.recipients.forEach((r) => sendTo(r.ws, { type: 'expired' }))
      sessions.delete(code)
    }
  }, IDLE_TIMEOUT_MS)
  if (idleTimer.unref) idleTimer.unref()

  const session: Session = {
    code,
    publisher: null,
    recipients: new Map(),
    createdAt: Date.now(),
    expiresAt: Date.now() + ttlMs,
    ttlTimer: timer,
    idleTimer,
    passwordHash,
  }

  sessions.set(code, session)
  console.log(`[session] created ${code} (ttl ${ttlMs / 1000}s)`)
  return code
}

export function getSession(code: string): Session | undefined {
  return sessions.get(code)
}

export function addPeer(code: string, role: PeerRole, ws: WebSocket): { session: Session; peer: Peer } | null {
  const session = sessions.get(code)
  if (!session) return null

  if (role === 'publisher') {
    if (session.publisher) return null // Only one publisher allowed

    const peer: Peer = { ws, role, id: 'publisher', connectedAt: Date.now() }
    session.publisher = peer
    // FIX 7: publisher joined — clear idle timer
    if (session.idleTimer) {
      clearTimeout(session.idleTimer)
      session.idleTimer = null
    }
    logger.info({ code }, 'Publisher joined session')
    return { session, peer }

  } else {
    // FIX 2: Enforce recipient cap before adding
    if (session.recipients.size >= MAX_RECIPIENTS_PER_SESSION) {
      logger.warn({ code, limit: MAX_RECIPIENTS_PER_SESSION }, 'Recipient limit reached')
      return null
    }

    const id = randomUUID()
    const peer: Peer = { ws, role, id, connectedAt: Date.now() }
    session.recipients.set(id, peer)
    console.log(`[session] recipient ${id.slice(0, 8)} joined ${code} (total: ${session.recipients.size}/${MAX_RECIPIENTS_PER_SESSION})`)
    return { session, peer }
  }
}

export function removePeer(code: string, peerId: string, role: PeerRole): void {
  const session = sessions.get(code)
  if (!session) return

  if (role === 'publisher') {
    console.log(`[session] publisher left ${code} — destroying session`)
    // Publisher leaving means the session is dead — files only exist in their
    // browser RAM. Destroy the session immediately so new recipients cannot
    // join a session that can never transfer anything.
    session.recipients.forEach((r) => {
      sendTo(r.ws, { type: 'peer_left' })
      // Close their WebSocket so they cannot retry and get confused
      r.ws.close(1000, 'Publisher disconnected — session ended')
    })
    destroySession(code)
    return
  } else {
    session.recipients.delete(peerId)
    console.log(`[session] recipient ${peerId.slice(0, 8)} left ${code} (remaining: ${session.recipients.size})`)
    if (session.publisher) {
      sendTo(session.publisher.ws, { type: 'peer_left', peerId })
    }
  }

  if (!session.publisher && session.recipients.size === 0) {
    destroySession(code)
  }
}

export function sendTo(ws: WebSocket, msg: SignalMessage): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg))
  }
}

function expireSession(code: string): void {
  const session = sessions.get(code)
  if (!session) return

  console.log(`[session] expired ${code}`)

  if (session.publisher) {
    sendTo(session.publisher.ws, { type: 'expired' })
    session.publisher.ws.close(1000, 'Session expired')
  }
  session.recipients.forEach((r) => {
    sendTo(r.ws, { type: 'expired' })
    r.ws.close(1000, 'Session expired')
  })

  sessions.delete(code)
}

function destroySession(code: string): void {
  const session = sessions.get(code)
  if (!session) return
  clearTimeout(session.ttlTimer)
  if (session.idleTimer) clearTimeout(session.idleTimer)
  sessions.delete(code)
  console.log(`[session] destroyed ${code}`)
}

export function activeSessions(): number {
  return sessions.size
}
