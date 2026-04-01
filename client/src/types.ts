export type PeerRole = 'publisher' | 'recipient'

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
