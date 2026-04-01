import { SignalingClient } from './signalingClient'
import type { SignalMessage, PeerRole } from '../types'

const ICE_SERVERS: RTCIceServer[] = [
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
  onChannelStateChange: (state: ChannelState) => void
  onChannelMessage?: (data: string | ArrayBuffer) => void
}

export class WebRTCManager {
  private pc: RTCPeerConnection | null = null
  private channel: RTCDataChannel | null = null
  private opts: WebRTCManagerOptions
  private pendingCandidates: RTCIceCandidateInit[] = []
  private remoteDescriptionSet = false

  constructor(opts: WebRTCManagerOptions) {
    this.opts = opts
  }

  async start(): Promise<void> {
    this.pc = new RTCPeerConnection({ iceServers: ICE_SERVERS })

    this.pc.onicecandidate = ({ candidate }) => {
      if (candidate) {
        this.opts.signalingClient.send({
          type: 'ice',
          payload: candidate.toJSON(),
          peerId: this.opts.peerId,
        })
      }
    }

    this.pc.oniceconnectionstatechange = () => {
      console.log(`[webrtc:${this.opts.peerId.slice(0, 8)}] ICE:`, this.pc?.iceConnectionState)
    }

    this.pc.onconnectionstatechange = () => {
      const state = this.pc?.connectionState
      console.log(`[webrtc:${this.opts.peerId.slice(0, 8)}] conn:`, state)
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
      console.log(`[webrtc] offer sent to ${this.opts.peerId.slice(0, 8)}`)
    } catch (err) {
      console.error('[webrtc] createOffer failed:', err)
      this.opts.onChannelStateChange('error')
    }
  }

  private startAsRecipient(): void {
    if (!this.pc) return
    this.pc.ondatachannel = (event) => {
      console.log('[webrtc] data channel received')
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
        console.log('[webrtc] answer sent')
      }

      if (msg.type === 'answer') {
        await this.pc.setRemoteDescription(msg.payload as RTCSessionDescriptionInit)
        this.remoteDescriptionSet = true
        await this.flushPendingCandidates()
        console.log('[webrtc] remote desc set from answer')
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
      console.error('[webrtc] handleSignal error:', err)
    }
  }

  private async flushPendingCandidates(): Promise<void> {
    if (!this.pc || this.pendingCandidates.length === 0) return
    for (const init of this.pendingCandidates) {
      try { await this.pc.addIceCandidate(new RTCIceCandidate(init)) }
      catch (err) { console.warn('[webrtc] buffered ICE failed:', err) }
    }
    this.pendingCandidates = []
  }

  getDataChannel(): RTCDataChannel | null {
    return this.channel
  }

  send(data: string | ArrayBuffer): void {
    if (this.channel?.readyState === 'open') {
      this.channel.send(data as string & ArrayBuffer)
    } else {
      console.warn('[webrtc] channel not open:', this.channel?.readyState)
    }
  }

  close(): void {
    this.channel?.close()
    this.pc?.close()
    this.channel = null
    this.pc = null
    this.remoteDescriptionSet = false
    this.pendingCandidates = []
  }

  private setupChannel(channel: RTCDataChannel): void {
    this.opts.onChannelStateChange('connecting')
    channel.onopen = () => {
      console.log('[webrtc] channel open')
      this.opts.onChannelStateChange('open')
    }
    channel.onclose = () => {
      console.log('[webrtc] channel closed')
      this.opts.onChannelStateChange('closed')
    }
    channel.onerror = (err) => {
      console.error('[webrtc] channel error:', err)
      this.opts.onChannelStateChange('error')
    }
    channel.onmessage = (event: MessageEvent) => {
      this.opts.onChannelMessage?.(event.data)
    }
  }
}
