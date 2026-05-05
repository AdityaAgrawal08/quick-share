import { WebSocket } from 'ws'

export type PeerRole = 'publisher' | 'recipient'

export interface Peer {
  ws: WebSocket
  role: PeerRole
  id: string
  connectedAt: number
}

export interface Session {
  code: string
  publisher: Peer | null
  recipients: Map<string, Peer>
  createdAt: number
  expiresAt: number
  ttlTimer: ReturnType<typeof setTimeout>
  idleTimer: ReturnType<typeof setTimeout> | null  // FIX 7: cleared when publisher joins
  passwordHash?: string // For mandatory P2P password protection
}

export type SignalType =
  | 'join'
  | 'ready'
  | 'offer'
  | 'answer'
  | 'ice'
  | 'error'
  | 'expired'
  | 'peer_left'
  | 'abort'      // Phase 5: publisher signals transfer was aborted

export interface SignalMessage {
  type: SignalType
  payload?: unknown
  peerId?: string
}

export interface JoinPayload {
  code: string
  role: PeerRole
}
