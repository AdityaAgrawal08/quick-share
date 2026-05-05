import { SignalingClient } from './signalingClient'
import type { SignalMessage, PeerRole } from '../types'

const DEFAULT_ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
]

export type ChannelState = 'idle' | 'connecting' | 'open' | 'closed' | 'error'

interface WebRTCManagerOptions {
  role: PeerRole
  // peerId identifies which recipient this connection is for.
  // Publisher uses it to tag outgoing signals; recipient uses it to tag signals back.
  peerId: string
  signalingClient: SignalingClient
  iceServers?: RTCIceServer[]
  onChannelStateChange: (state: ChannelState) => void
  onChannelMessage?: (data: string | ArrayBuffer) => void
}

export class WebRTCManager {
  private pc: RTCPeerConnection | null = null
  private channel: RTCDataChannel | null = null
  private opts: WebRTCManagerOptions
  private pendingCandidates: RTCIceCandidateInit[] = []
  private remoteDescriptionSet = false
  private gatheredCandidateTypes = new Set<string>()  // Track candidate types for debugging

  constructor(opts: WebRTCManagerOptions) {
    this.opts = opts
  }

  async start(): Promise<void> {
    const servers = this.opts.iceServers ?? DEFAULT_ICE_SERVERS
    this.pc = new RTCPeerConnection({ iceServers: servers })

    this.pc.onicecandidate = ({ candidate }) => {
      if (candidate) {
        const candidateType = candidate.type ?? 'unknown' // 'host', 'srflx', 'relay', 'prflx'
        this.gatheredCandidateTypes.add(candidateType)
        
        this.opts.signalingClient.send({
          type: 'ice',
          payload: candidate.toJSON(),
          peerId: this.opts.peerId,
        })
      } else {
        // null candidate = candidate gathering complete
        const types = Array.from(this.gatheredCandidateTypes)
        void types
      }
    }

    this.pc.oniceconnectionstatechange = () => {
      const state = this.pc?.iceConnectionState
      
      // FIX 7: Detect specific ICE failure modes
      if (state === 'failed') {
        // ICE failed to establish any connection. Possible reasons:
        // - NAT/firewall blocking UDP
        // - Symmetric NAT (needs TURN)
        // - Misconfigured STUN/TURN
        // - Network routing issue
        this.opts.onChannelStateChange('error')
      }
    }

    this.pc.onconnectionstatechange = () => {
      const state = this.pc?.connectionState
      if (state === 'failed' || state === 'disconnected') {
        this.opts.onChannelStateChange('error')
      }
    }

    if (this.opts.role === 'publisher') {
      await this.startAsPublisher()
    } else {
      this.startAsRecipient()
    }
  }

  private async startAsPublisher(): Promise<void> {
    if (!this.pc) return
    this.channel = this.pc.createDataChannel('transfer', { ordered: true })
    this.setupChannel(this.channel)
    try {
      const offer = await this.pc.createOffer()
      await this.pc.setLocalDescription(offer)
      this.opts.signalingClient.send({
        type: 'offer',
        payload: offer,
        peerId: this.opts.peerId,
      })
    } catch (err) {
      this.opts.onChannelStateChange('error')
    }
  }

  private startAsRecipient(): void {
    if (!this.pc) return
    this.pc.ondatachannel = (event) => {
      this.channel = event.channel
      this.setupChannel(this.channel)
    }
  }

  async handleSignal(msg: SignalMessage): Promise<void> {
    if (!this.pc) return
    try {
      if (msg.type === 'offer') {
        await this.pc.setRemoteDescription(msg.payload as RTCSessionDescriptionInit)
        this.remoteDescriptionSet = true
        await this.flushPendingCandidates()
        const answer = await this.pc.createAnswer()
        await this.pc.setLocalDescription(answer)
        this.opts.signalingClient.send({
          type: 'answer',
          payload: answer,
          peerId: this.opts.peerId,
        })
      }

      if (msg.type === 'answer') {
        await this.pc.setRemoteDescription(msg.payload as RTCSessionDescriptionInit)
        this.remoteDescriptionSet = true
        await this.flushPendingCandidates()
      }

      if (msg.type === 'ice') {
        const init = msg.payload as RTCIceCandidateInit
        if (this.remoteDescriptionSet) {
          await this.pc.addIceCandidate(new RTCIceCandidate(init))
        } else {
          this.pendingCandidates.push(init)
        }
      }
    } catch (err) {
      this.opts.onChannelStateChange('error')
    }
  }

  private async flushPendingCandidates(): Promise<void> {
    if (!this.pc || this.pendingCandidates.length === 0) return
    for (const init of this.pendingCandidates) {
      try { await this.pc.addIceCandidate(new RTCIceCandidate(init)) }
      catch {
        this.opts.onChannelStateChange('error')
      }
    }
    this.pendingCandidates = []
  }

  getDataChannel(): RTCDataChannel | null {
    return this.channel
  }

  send(data: string | ArrayBuffer): void {
    if (this.channel?.readyState === 'open') {
      this.channel.send(data as string & ArrayBuffer)
    }
  }

  close(): void {
    this.channel?.close()
    this.pc?.close()
    this.channel = null
    this.pc = null
    this.remoteDescriptionSet = false
    this.pendingCandidates = []
    this.gatheredCandidateTypes.clear()
  }

  private setupChannel(channel: RTCDataChannel): void {
    this.opts.onChannelStateChange('connecting')
    channel.onopen = () => {
      this.opts.onChannelStateChange('open')
    }
    channel.onclose = () => {
      this.opts.onChannelStateChange('closed')
    }
    channel.onerror = () => {
      this.opts.onChannelStateChange('error')
    }
    channel.onmessage = (event: MessageEvent) => {
      this.opts.onChannelMessage?.(event.data)
    }
  }
}
