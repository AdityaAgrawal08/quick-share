import { useState, useRef, useEffect, useCallback } from 'react'
import { QRCodeSVG } from 'qrcode.react'
import { SignalingClient } from './lib/signalingClient'
import { WebRTCManager, type ChannelState } from './lib/webrtc'
import { TransferReceiver, sendTransfer, type TransferProgress, type ReceivedTransfer, type ReceivedFile } from './lib/transfer'
import type { SignalMessage, PeerRole } from './types'

const API_URL       = import.meta.env.VITE_API_URL ?? 'http://localhost:3001'
const SIGNALING_URL = API_URL.replace(/^http/, 'ws')
const STORED_TTL_MIN = 10 * 60
const STORED_TTL_MAX = 60 * 60
const STORED_MAX    = 10 * 1024 * 1024

function formatTTL(s: number): string {
  if (s < 3600) return `${Math.round(s / 60)} min`
  const h = s / 3600
  return h === Math.floor(h) ? `${h} hr` : `${h.toFixed(1)} hr`
}

function formatBytes(b: number): string {
  if (b < 1024) return `${b} B`
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(0)} KB`
  return `${(b / 1024 / 1024).toFixed(1)} MB`
}

function getTextBytes(text: string): number {
  return new TextEncoder().encode(text).length
}

function splitStoredTtl(seconds: number): { hours: number; minutes: number } {
  const clamped = Math.min(Math.max(seconds, STORED_TTL_MIN), STORED_TTL_MAX)
  if (clamped >= STORED_TTL_MAX) return { hours: 1, minutes: 0 }
  return { hours: 0, minutes: Math.max(10, Math.round(clamped / 60)) }
}

function formatCountdown(ms: number): string {
  if (ms <= 0) return 'Expired'
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`
  return `${Math.floor(m / 60)}h ${m % 60}m`
}

function anchorDownload(url: string, filename: string) {
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.style.display = 'none'
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
}

type PublishMode = 'stored' | 'live'

interface StoredFileInfo { name: string; mimeType: string; size: number; fileId: string; token: string }
interface RetrievedPayload { mode: 'stored'; text: string; expiresAt: number; files: StoredFileInfo[] }
interface RecipientConn {
  peerId: string; displayName: string; rtc: WebRTCManager
  channelState: ChannelState; sendProgress: TransferProgress | null; lastSentAt: number | null
}

const T = {
  bg:       '#08090a',
  surface:  '#0f1013',
  border:   '#1e2024',
  borderHi: '#2e3138',
  text:     '#e8e9eb',
  muted:    '#6b7280',
  dim:      '#3d4047',
  accent:   '#00c2ff',
  accentDim:'#003d52',
  green:    '#22c55e',
  amber:    '#f59e0b',
  red:      '#ef4444',
  radius:   '8px',
  radiusSm: '5px',
  mono:     "'IBM Plex Mono', 'Fira Code', monospace",
  sans:     "'DM Sans', system-ui, sans-serif",
}

export default function App() {
  const [view, setView]               = useState<'home' | 'publish' | 'join'>('home')
  const [code, setCode]               = useState('')
  const [inputCode, setInputCode]     = useState('')
  const [text, setText]               = useState('')
  const [files, setFiles]             = useState<File[]>([])
  const [ttlSeconds, setTtlSeconds]   = useState(STORED_TTL_MAX)
  const [publishing, setPublishing]   = useState(false)
  const [uploadPercent, setUploadPercent] = useState<number | null>(null)
  const [publishedMode, setPublishedMode] = useState<PublishMode | null>(null)
  const [expiresAt, setExpiresAt]     = useState<number | null>(null)
  const [copiedCode, setCopiedCode]   = useState(false)
  const [sigState, setSigState]       = useState('disconnected')
  const [recipients, setRecipients]   = useState<RecipientConn[]>([])
  const [recipientName, setRecipientName] = useState('')
  const [channelState, setChannelState]   = useState<ChannelState>('idle')
  const [recvProgress, setRecvProgress]   = useState<TransferProgress | null>(null)
  const [received, setReceived]           = useState<ReceivedTransfer | null>(null)
  const [storedPayload, setStoredPayload] = useState<RetrievedPayload | null>(null)
  const [transferError, setTransferError] = useState<string | null>(null)
  const [joining, setJoining]             = useState(false)
  const [joinError, setJoinError]         = useState('')
  const [countdown, setCountdown]         = useState('')
  const [storedEnabled, setStoredEnabled] = useState(true)
  const [publishError, setPublishError]   = useState('')

  const sigRef            = useRef<SignalingClient | null>(null)
  const rtcMapRef         = useRef<Map<string, WebRTCManager>>(new Map())
  const rtcRef            = useRef<WebRTCManager | null>(null)
  const receiverRef       = useRef<TransferReceiver | null>(null)
  const recipientCountRef = useRef(0)
  const p2pEverLiveRef    = useRef(false)
  const iceServersRef     = useRef<RTCIceServer[]>([])
  const copyTimerRef      = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (!expiresAt) { setCountdown(''); return }
    const tick = () => setCountdown(formatCountdown(expiresAt - Date.now()))
    tick()
    const id = setInterval(tick, 1000)
    return () => clearInterval(id)
  }, [expiresAt])

  useEffect(() => {
    const path = window.location.pathname.replace(/^\//, '').trim()
    if (/^\d{6}$/.test(path)) {
      setInputCode(path)
      window.history.replaceState(null, '', '/')
    }
  }, [])

  useEffect(() => {
    // Detect whether server has Mongo configured (stored mode enabled).
    fetch(`${API_URL}/health`)
      .then(r => r.json())
      .then((data: { storedModeEnabled?: boolean }) => {
        if (typeof data.storedModeEnabled === 'boolean') setStoredEnabled(data.storedModeEnabled)
      })
      .catch(() => {
        // Ignore; default stays true.
      })
  }, [])

  const totalBytes     = files.reduce((s, f) => s + f.size, 0)
  const textBytes      = getTextBytes(text)
  const payloadBytes   = totalBytes + textBytes
  const mode: PublishMode =
    publishedMode === 'stored' ? 'stored' :
    publishedMode === 'live' ? 'live' :
    payloadBytes <= STORED_MAX ? 'stored' : 'live'
  const hasPayload     = text.trim().length > 0 || files.length > 0
  const openRecipients = recipients.filter(r => r.channelState === 'open')

  function copyCode() {
    if (!code) return
    navigator.clipboard.writeText(code).catch(() => {
      const el = document.createElement('textarea')
      el.value = code
      document.body.appendChild(el)
      el.select()
      document.execCommand('copy')
      document.body.removeChild(el)
    })
    setCopiedCode(true)
    if (copyTimerRef.current) clearTimeout(copyTimerRef.current)
    copyTimerRef.current = setTimeout(() => setCopiedCode(false), 2000)
  }

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const selected = Array.from(e.target.files ?? [])
    setFiles(prev => {
      const existing = new Set(prev.map(f => `${f.name}:${f.size}`))
      return [...prev, ...selected.filter(f => !existing.has(`${f.name}:${f.size}`))]
    })
    e.target.value = ''
  }

  function clampStoredTtl(seconds: number): number {
    return Math.min(Math.max(seconds, STORED_TTL_MIN), STORED_TTL_MAX)
  }

  function setStoredDuration(hoursValue: number, minutesValue: number) {
    const hours = Number.isFinite(hoursValue) ? Math.max(0, Math.min(1, Math.trunc(hoursValue))) : 0
    const minutes = Number.isFinite(minutesValue) ? Math.max(0, Math.min(59, Math.trunc(minutesValue))) : 0

    if (hours >= 1) {
      setTtlSeconds(STORED_TTL_MAX)
      return
    }

    setTtlSeconds(clampStoredTtl(Math.max(10, minutes) * 60))
  }

  async function handleStoredPublish() {
    if (!hasPayload) return
    setPublishing(true)
    setPublishError('')
    setUploadPercent(null)
    const isUpdate = publishedMode === 'stored' && code !== ''
    try {
      const form = new FormData()
      form.append('text', text)
      form.append('ttlMs', String(clampStoredTtl(ttlSeconds) * 1000))
      files.forEach(f => form.append('files', f))
      const url    = isUpdate ? `${API_URL}/publish/${code}` : `${API_URL}/publish`
      const method = isUpdate ? 'PATCH' : 'POST'
      const data = await new Promise<{ code: string; expiresAt: number; mode: string; error?: string }>((resolve, reject) => {
        const xhr = new XMLHttpRequest()
        xhr.open(method, url)
        if (files.length > 0) {
          xhr.upload.onprogress = e => { if (e.lengthComputable) setUploadPercent(Math.round(e.loaded / e.total * 100)) }
        }
        xhr.onload  = () => resolve(JSON.parse(xhr.responseText))
        xhr.onerror = () => reject(new Error('Network error'))
        xhr.send(form)
      })
      setUploadPercent(null)
      if (data.error) {
        setPublishError(data.error)
        if (data.error.includes('not found') && isUpdate) { setCode(''); setPublishedMode(null) }
        setPublishing(false)
        return
      }
      setCode(data.code)
      setExpiresAt(data.expiresAt)
      setPublishedMode('stored')
    } catch {
      setUploadPercent(null)
      setPublishError('Network error. Check your connection.')
    }
    setPublishing(false)
  }

  async function handleLivePublish() {
    setPublishing(true)
    setPublishError('')
    await fetchIceServers()
    try {
      const res  = await fetch(`${API_URL}/session`, { 
        method: 'POST', 
        headers: { 
          'Content-Type': 'application/json',
        }, 
        body: JSON.stringify({ ttlMs: 24 * 60 * 60 * 1000 }) 
      })
      const data = await res.json()
      if (!res.ok) {
        setPublishError((data as any)?.error ?? 'Failed to create session')
        setPublishing(false)
        return
      }
      setCode(data.code)
      setPublishedMode('live')
      setExpiresAt(data.expiresAt)
      startSignaling(data.code, 'publisher')
    } catch {
      setPublishError('Network error. Check your connection.')
    }
    setPublishing(false)
  }

  async function handleSendTo(peerId: string) {
    if (!hasPayload) return
    const rtc = rtcMapRef.current.get(peerId)
    const r   = recipients.find(r => r.peerId === peerId)
    if (!rtc || !r || r.channelState !== 'open') return
    setRecipients(prev => prev.map(x => x.peerId === peerId ? { ...x, sendProgress: null } : x))
    try {
      await sendTransfer(rtc, text, files, p => {
        setRecipients(prev => prev.map(x => x.peerId === peerId ? { ...x, sendProgress: p } : x))
      })
      setRecipients(prev => prev.map(x => x.peerId === peerId ? { ...x, lastSentAt: Date.now(), sendProgress: null } : x))
    } catch { /* error visible via channel state */ }
  }

  async function handleSendAll() {
    await Promise.allSettled(openRecipients.map(r => handleSendTo(r.peerId)))
  }

  async function handleJoin() {
    if (inputCode.length !== 6) return
    setJoining(true)
    setJoinError('')
    try {
      const res = await fetch(`${API_URL}/retrieve/${inputCode}`)
      if (res.ok) {
        const data: RetrievedPayload = await res.json()
        setStoredPayload(data)
        setCode(inputCode)
        setExpiresAt(data.expiresAt)
        setView('join')
        setJoining(false)
        return
      }
      if (res.status === 410) { setJoinError('This session has expired.'); setJoining(false); return }
      if (res.status === 404) {
        const data = await res.json()
        if (data.error === 'live_session') {
          setCode(inputCode)
          setView('join')
          startSignaling(inputCode, 'recipient')
          setJoining(false)
          return
        }
        setJoinError('Session not found. Check the code.')
        setJoining(false)
        return
      }
      const err = await res.json()
      setJoinError(err.error ?? 'Unknown error')
    } catch { setJoinError('Network error. Check your connection.') }
    setJoining(false)
  }

  function handleStoredDownload(f: StoredFileInfo) {
    anchorDownload(`${API_URL}/file/${f.fileId}/${f.token}`, f.name)
  }

  function handleStoredPreview(f: StoredFileInfo) {
    window.open(`${API_URL}/file/${f.fileId}/${f.token}`, '_blank', 'noopener')
  }

  function handleLiveDownload(f: ReceivedFile) {
    const url = URL.createObjectURL(f.blob)
    anchorDownload(url, f.name)
    setTimeout(() => URL.revokeObjectURL(url), 10000)
  }

  function handleLivePreview(f: ReceivedFile) {
    const url = URL.createObjectURL(f.blob)
    window.open(url, '_blank', 'noopener')
    setTimeout(() => URL.revokeObjectURL(url), 60000)
  }

  const fetchIceServers = useCallback(async (): Promise<RTCIceServer[]> => {
    if (iceServersRef.current.length > 0) return iceServersRef.current
    try {
      const res  = await fetch(`${API_URL}/ice-servers`)
      if (!res.ok) throw new Error()
      const data = await res.json() as { iceServers: RTCIceServer[] }
      iceServersRef.current = data.iceServers
      return data.iceServers
    } catch {
      return [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' }]
    }
  }, [])

  function startSignaling(sessionCode: string, sessionRole: PeerRole) {
    const sig = new SignalingClient({
      serverUrl: SIGNALING_URL,
      code: sessionCode,
      role: sessionRole,
      onOpen:  () => setSigState('connected'),
      onClose: () => setSigState('disconnected'),
      onError: () => {},
      onMessage: msg => handleSignalingMessage(msg, sessionRole, sig),
      onReconnecting: (attempt, max) => {
        if (p2pEverLiveRef.current) { sigRef.current?.disconnect(); setSigState('offline'); return }
        setSigState(`reconnecting ${attempt}/${max}`)
      },
      onReconnectFailed: () => setSigState(p2pEverLiveRef.current ? 'offline' : 'failed'),
    })
    sigRef.current = sig
    sig.connect()
  }

  async function handleSignalingMessage(msg: SignalMessage, sessionRole: PeerRole, sig: SignalingClient) {
    if (msg.type === 'error') {
      if (typeof msg.payload === 'string' && msg.payload.startsWith('Waiting for publisher')) return
      if (typeof msg.payload === 'string' && msg.payload.startsWith('Session not found')) {
        if (p2pEverLiveRef.current) { sigRef.current?.disconnect(); setSigState('offline') }
        else setSigState('lost')
        return
      }
      return
    }
    if (msg.type === 'expired') { setSigState('expired'); return }
    if (msg.type === 'peer_left') {
      if (sessionRole === 'publisher' && msg.peerId) {
        rtcMapRef.current.get(msg.peerId)?.close()
        rtcMapRef.current.delete(msg.peerId)
        setRecipients(prev => prev.filter(r => r.peerId !== msg.peerId))
      } else {
        setChannelState('closed')
      }
      return
    }
    if (msg.type === 'ready') {
      const peerId = msg.peerId
      if (!peerId) return
      if (sessionRole === 'publisher') {
        recipientCountRef.current += 1
        const autoName = `Recipient ${recipientCountRef.current}`
        const rtc = new WebRTCManager({
          role: 'publisher', peerId, signalingClient: sig,
          iceServers: iceServersRef.current.length > 0 ? iceServersRef.current : undefined,
          onChannelStateChange: state => {
            if (state === 'open') p2pEverLiveRef.current = true
            setRecipients(prev => prev.map(r => r.peerId === peerId ? { ...r, channelState: state } : r))
          },
          onChannelMessage: data => {
            if (typeof data === 'string') {
              try {
                const parsed = JSON.parse(data)
                if (parsed.type === 'name' && parsed.name?.trim()) {
                  setRecipients(prev => prev.map(r => r.peerId === peerId ? { ...r, displayName: parsed.name.trim() } : r))
                }
              } catch { /* not a name message */ }
            }
          },
        })
        rtcMapRef.current.set(peerId, rtc)
        setRecipients(prev => [...prev, { peerId, displayName: autoName, rtc, channelState: 'idle', sendProgress: null, lastSentAt: null }])
        await rtc.start()
      } else {
        await fetchIceServers()
        const receiver = new TransferReceiver(
          p => setRecvProgress(p),
          result => { setReceived(result); setTransferError(null) },
          reason => { setTransferError(reason); setRecvProgress(null) }
        )
        receiverRef.current = receiver
        const rtc = new WebRTCManager({
          role: 'recipient', peerId, signalingClient: sig,
          iceServers: iceServersRef.current.length > 0 ? iceServersRef.current : undefined,
          onChannelStateChange: state => {
            if (state === 'open') p2pEverLiveRef.current = true
            setChannelState(state)
            if (state === 'open' && recipientName.trim()) rtc.send(JSON.stringify({ type: 'name', name: recipientName.trim() }))
            if ((state === 'closed' || state === 'error') && receiverRef.current) {
              receiverRef.current.abort('Publisher disconnected mid-transfer')
              receiverRef.current = null
            }
          },
          onChannelMessage: data => receiver.receive(data),
        })
        rtcRef.current = rtc
        await rtc.start()
      }
      return
    }
    if (sessionRole === 'publisher') {
      const rtc = msg.peerId ? rtcMapRef.current.get(msg.peerId) : null
      if (rtc) await rtc.handleSignal(msg)
    } else {
      if (rtcRef.current) await rtcRef.current.handleSignal(msg)
    }
  }

  function reset() {
    rtcMapRef.current.forEach(r => r.close())
    rtcMapRef.current.clear()
    rtcRef.current?.close(); rtcRef.current = null
    sigRef.current?.disconnect(); sigRef.current = null
    receiverRef.current = null
    recipientCountRef.current = 0
    p2pEverLiveRef.current = false
    iceServersRef.current = []
    if (copyTimerRef.current) clearTimeout(copyTimerRef.current)
    setView('home'); setCode(''); setInputCode('')
    setText(''); setFiles([]); setTtlSeconds(3600)
    setPublishing(false); setPublishedMode(null); setExpiresAt(null)
    setUploadPercent(null); setCopiedCode(false)
    setSigState('disconnected'); setRecipients([])
    setChannelState('idle'); setRecvProgress(null)
    setReceived(null); setStoredPayload(null); setTransferError(null)
    setJoining(false); setJoinError(''); setRecipientName('')
    setCountdown('')
  }

  function sigColor() {
    if (['failed','lost','expired'].includes(sigState)) return T.red
    if (sigState.startsWith('reconnecting') || sigState === 'offline') return T.amber
    if (sigState === 'connected') return T.green
    return T.muted
  }

  const qrUrl = `${window.location.origin}/${code}`

  function FilePills({ fileList, onRemove }: { fileList: File[]; onRemove: (i: number) => void }) {
    return (
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', marginTop: '8px' }}>
        {fileList.map((f, i) => (
          <Pill key={i}>
            <span style={{ maxWidth: '160px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.name}</span>
            <span style={{ fontSize: '11px', color: T.muted, flexShrink: 0 }}>{formatBytes(f.size)}</span>
            <button onClick={() => onRemove(i)} style={{ background: 'none', border: 'none', color: T.red, padding: '0 2px', fontSize: '13px', lineHeight: 1, cursor: 'pointer' }}>✕</button>
          </Pill>
        ))}
        <div style={{ width: '100%', fontSize: '12px', color: T.muted, marginTop: '2px' }}>
          {formatBytes(payloadBytes)} total{payloadBytes > STORED_MAX && <span style={{ color: T.amber, marginLeft: '8px' }}>↑ live mode</span>}
        </div>
      </div>
    )
  }

  function DurationPicker() {
    const parts = splitStoredTtl(ttlSeconds)

    return (
      <div style={{ marginTop: '14px' }}>
        <div style={{ fontSize: '12px', color: T.muted, marginBottom: '8px' }}>
          Duration <span style={{ color: T.text, fontFamily: T.mono, marginLeft: '6px' }}>{formatTTL(ttlSeconds)}</span>
        </div>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '1fr auto 1fr',
            gap: '10px',
            alignItems: 'stretch',
            padding: '10px',
            borderRadius: T.radius,
            border: `1px solid ${T.borderHi}`,
            background: `linear-gradient(180deg, ${T.surface}, #0b0c0f)`,
            boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.02)',
          }}
        >
          <label style={{ display: 'grid', gap: '6px' }}>
            <span style={{ fontSize: '11px', color: T.dim, letterSpacing: '1px', textTransform: 'uppercase' }}>hr</span>
            <input
              type="number"
              min={0}
              max={1}
              value={parts.hours}
              inputMode="numeric"
              onChange={e => setStoredDuration(Number(e.target.value), parts.minutes)}
              style={{ ...durationInputStyle(), textAlign: 'center', fontFamily: T.mono }}
            />
          </label>

          <div style={{ display: 'flex', alignItems: 'end', justifyContent: 'center', paddingBottom: '12px', color: T.dim, fontFamily: T.mono }}>
            :
          </div>

          <label style={{ display: 'grid', gap: '6px' }}>
            <span style={{ fontSize: '11px', color: T.dim, letterSpacing: '1px', textTransform: 'uppercase' }}>min</span>
            <input
              type="number"
              min={0}
              max={59}
              value={parts.minutes}
              inputMode="numeric"
              onChange={e => setStoredDuration(parts.hours, Number(e.target.value))}
              style={{ ...durationInputStyle(), textAlign: 'center', fontFamily: T.mono }}
            />
          </label>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px', color: T.dim, marginTop: '4px' }}>
          <span>10 min</span>
          <span>1 hr</span>
        </div>
      </div>
    )
  }

  function durationInputStyle(): React.CSSProperties {
    return {
      width: '100%',
      minHeight: '56px',
      borderRadius: T.radiusSm,
      border: `1px solid ${T.border}`,
      background: '#090a0d',
      color: T.text,
      fontSize: '20px',
      fontWeight: 600,
      outline: 'none',
      padding: '0 12px',
    }
  }

  return (
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap');
        *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
        html { scroll-behavior: smooth; }
        html, body { background: ${T.bg}; color: ${T.text}; font-family: ${T.sans}; min-height: 100vh; -webkit-text-size-adjust: 100%; }
        input, textarea, button, select { font-family: inherit; }
        button { cursor: pointer; -webkit-tap-highlight-color: transparent; }
        textarea { font-size: 16px; }
        input[type="text"], input[type="number"] { font-size: 16px; }
        ::-webkit-scrollbar { width: 4px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: ${T.dim}; border-radius: 2px; }
        @keyframes fadeIn { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
        @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.5; } }
        @keyframes spin { to { transform: rotate(360deg); } }
        .fade-in { animation: fadeIn 0.2s ease forwards; }
        @media (max-width: 480px) {
          .row-wrap { flex-wrap: wrap; }
          .row-wrap > * { min-width: 0; flex: 1 1 100%; }
          .row-wrap > .no-grow { flex: 0 0 auto; }
        }
      `}</style>

      <div style={{ maxWidth: '560px', margin: '0 auto', padding: 'clamp(1.25rem, 5vw, 2.5rem) clamp(1rem, 4vw, 1.5rem) 4rem' }}>

        <div style={{ marginBottom: '2rem', display: 'flex', alignItems: 'baseline', gap: '10px' }}>
          <span style={{ fontFamily: T.mono, fontSize: '17px', fontWeight: 500, color: T.accent }}>quickshare</span>
          <span style={{ fontSize: '12px', color: T.muted }}>private file & text transfer</span>
        </div>

        {view === 'home' && !publishedMode && (
          <div className="fade-in">
            <Card>
              <Btn primary onClick={() => setView('publish')} style={{ width: '100%', padding: '13px' }}>
                Create session
              </Btn>
            </Card>

            <div style={{ textAlign: 'center', color: T.muted, fontSize: '13px', margin: '12px 0' }}>or join with a code</div>

            <Card>
              <div style={{ display: 'flex', gap: '8px', alignItems: 'stretch' }} className="row-wrap">
                <input
                  placeholder="000000"
                  value={inputCode}
                  onChange={e => setInputCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                  maxLength={6}
                  onKeyDown={e => e.key === 'Enter' && inputCode.length === 6 && handleJoin()}
                  style={{ ...iStyle(), fontFamily: T.mono, fontSize: '22px', letterSpacing: '6px', textAlign: 'center', width: '148px', flexShrink: 0 }}
                  className="no-grow"
                />
                <input
                  placeholder="Your name (optional)"
                  value={recipientName}
                  onChange={e => setRecipientName(e.target.value)}
                  style={{ ...iStyle(), flex: 1, minWidth: '120px' }}
                />
                <Btn primary onClick={handleJoin} disabled={inputCode.length !== 6 || joining} style={{ minHeight: '44px', paddingLeft: '20px', paddingRight: '20px' }} className="no-grow">
                  {joining ? <Spinner /> : 'Join'}
                </Btn>
              </div>
              {joinError && <div style={{ marginTop: '10px', fontSize: '13px', color: T.red }}>{joinError}</div>}
            </Card>
          </div>
        )}

        {view === 'publish' && !publishedMode && (
          <div className="fade-in">
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '16px' }}>
              <span style={{ fontSize: '15px', fontWeight: 500 }}>New session</span>
              <Btn small onClick={() => setView('home')} style={{ color: T.muted }}>← Back</Btn>
            </div>

            <Card>
              <div style={{ fontSize: '12px', color: T.muted, marginBottom: '8px' }}>Text <span style={{ opacity: 0.6 }}>(optional)</span></div>
              <textarea
                style={{ ...iStyle({ width: '100%', height: '100px', resize: 'vertical' }), display: 'block' }}
                placeholder="Paste text, code, links..."
                value={text}
                onChange={e => setText(e.target.value)}
              />
            </Card>

            <Card>
              <div style={{ fontSize: '12px', color: T.muted, marginBottom: '8px' }}>Files <span style={{ opacity: 0.6 }}>(optional)</span></div>
              <input type="file" multiple onChange={handleFileChange} style={{ color: T.muted, fontSize: '13px', width: '100%' }} />
              {files.length > 0 && <FilePills fileList={files} onRemove={i => setFiles(prev => prev.filter((_, j) => j !== i))} />}
            </Card>

            <Card>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <div style={{ width: '7px', height: '7px', borderRadius: '50%', background: mode === 'stored' ? T.green : T.amber, flexShrink: 0 }} />
                <span style={{ fontSize: '13px', color: mode === 'stored' ? T.green : T.amber }}>
                  {mode === 'stored' ? 'Stored in MongoDB — you can leave after publishing' : 'Live — stay connected while recipients join'}
                </span>
              </div>
              {mode === 'stored' && <DurationPicker />}
              {!storedEnabled && mode === 'stored' && (
                <div style={{ marginTop: '10px', fontSize: '12px', color: T.amber }}>
                  MongoDB is not enabled on the server right now, so stored publishing is unavailable until it is connected.
                </div>
              )}
            </Card>

            <Btn
              primary
              onClick={() => mode === 'stored' ? handleStoredPublish() : handleLivePublish()}
              disabled={(mode === 'stored' && !hasPayload) || publishing}
              style={{ width: '100%', padding: '13px', minHeight: '48px' }}
            >
              {publishing ? <><Spinner /> Publishing...</> : 'Publish'}
            </Btn>

            {publishError && (
              <div style={{ marginTop: '10px', fontSize: '13px', color: T.red }}>
                {publishError}
              </div>
            )}
          </div>
        )}

        {publishedMode === 'stored' && (
          <div className="fade-in">
            <Card style={{ textAlign: 'center', padding: '28px 20px' }}>
              <div style={{ fontSize: '11px', letterSpacing: '2px', textTransform: 'uppercase', color: T.muted, marginBottom: '10px' }}>Your code</div>
              <div style={{ fontFamily: T.mono, fontSize: 'clamp(36px, 10vw, 52px)', fontWeight: 500, letterSpacing: '10px', color: T.accent, marginBottom: '14px' }}>{code}</div>
              <Btn small onClick={copyCode} style={{ marginBottom: '18px', minWidth: '90px' }}>
                {copiedCode ? '✓ Copied' : 'Copy code'}
              </Btn>
              {code && (
                <div style={{ display: 'inline-block', padding: '12px', background: T.surface, borderRadius: T.radiusSm }}>
                  <QRCodeSVG value={qrUrl} size={140} bgColor="transparent" fgColor={T.text} level="M" />
                </div>
              )}
              {countdown && (
                <div style={{ marginTop: '12px', fontSize: '13px', color: countdown === 'Expired' ? T.red : T.muted }}>
                  {countdown === 'Expired' ? '⚠ Expired' : `Expires in ${countdown}`}
                </div>
              )}
              <div style={{ marginTop: '6px', fontSize: '12px', color: T.dim }}>You can close this tab. Edit below to update the stored session.</div>
            </Card>

            <Card>
              <div style={{ fontSize: '12px', color: T.muted, marginBottom: '8px' }}>Update content</div>
              <textarea
                style={{ ...iStyle({ width: '100%', height: '90px', resize: 'vertical' }), display: 'block' }}
                placeholder="Enter text to share..."
                value={text}
                onChange={e => setText(e.target.value)}
              />
              <div style={{ marginTop: '10px' }}>
                <input type="file" multiple onChange={handleFileChange} style={{ color: T.muted, fontSize: '13px', width: '100%' }} />
                {files.length > 0 && <FilePills fileList={files} onRemove={i => setFiles(prev => prev.filter((_, j) => j !== i))} />}
              </div>
              <DurationPicker />
              {payloadBytes > STORED_MAX && (
                <div style={{ marginTop: '10px', fontSize: '12px', color: T.red }}>Total payload exceeds 10 MB — switch to live mode or reduce content.</div>
              )}
              {uploadPercent !== null && (
                <div style={{ marginTop: '12px' }}>
                  <ProgressBar percent={uploadPercent} />
                  <div style={{ fontSize: '11px', color: T.muted, marginTop: '4px' }}>Uploading {uploadPercent}%</div>
                </div>
              )}
              <Btn primary onClick={handleStoredPublish} disabled={!hasPayload || publishing || payloadBytes > STORED_MAX} style={{ width: '100%', marginTop: '14px', minHeight: '44px' }}>
                {publishing ? <><Spinner /> Updating...</> : 'Publish update'}
              </Btn>
            </Card>
          </div>
        )}

        {publishedMode === 'live' && (
          <div className="fade-in">
            <Card style={{ padding: '18px 16px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '14px' }}>
                <div style={{ width: '7px', height: '7px', borderRadius: '50%', background: sigColor(), flexShrink: 0, animation: sigState.startsWith('reconnecting') ? 'pulse 1.5s infinite' : 'none' }} />
                <span style={{ fontSize: '12px', color: sigColor(), fontFamily: T.mono }}>{sigState}</span>
                <span style={{ marginLeft: 'auto', fontSize: '11px', color: T.dim }}>Keep tab open</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '14px', flexWrap: 'wrap' }}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: '10px', letterSpacing: '2px', textTransform: 'uppercase', color: T.muted, marginBottom: '4px' }}>Code</div>
                  <div style={{ fontFamily: T.mono, fontSize: 'clamp(28px, 8vw, 40px)', fontWeight: 500, letterSpacing: '8px', color: T.accent }}>{code}</div>
                  <Btn small onClick={copyCode} style={{ marginTop: '8px' }}>{copiedCode ? '✓ Copied' : 'Copy'}</Btn>
                </div>
                {code && (
                  <div style={{ padding: '8px', background: T.bg, borderRadius: T.radiusSm, flexShrink: 0 }}>
                    <QRCodeSVG value={qrUrl} size={84} bgColor="transparent" fgColor={T.text} level="M" />
                  </div>
                )}
              </div>
            </Card>

            <Card>
              <textarea
                style={{ ...iStyle({ width: '100%', height: '88px', resize: 'vertical' }), display: 'block', marginBottom: '10px' }}
                placeholder="Enter text to share..."
                value={text}
                onChange={e => setText(e.target.value)}
              />
              <input type="file" multiple onChange={handleFileChange} style={{ color: T.muted, fontSize: '13px', width: '100%' }} />
              {files.length > 0 && <FilePills fileList={files} onRemove={i => setFiles(prev => prev.filter((_, j) => j !== i))} />}
            </Card>

            <Card>
              {recipients.length === 0 ? (
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', color: T.muted, fontSize: '13px' }}>
                  <span style={{ animation: 'pulse 2s infinite' }}>⋯</span> Waiting for recipients...
                </div>
              ) : (
                <>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '12px' }}>
                    <span style={{ fontSize: '12px', color: T.muted }}>{recipients.length} recipient{recipients.length !== 1 ? 's' : ''}</span>
                    <Btn small primary onClick={handleSendAll} disabled={!hasPayload || openRecipients.length === 0}>Send all</Btn>
                  </div>
                  {recipients.map(r => (
                    <div key={r.peerId} style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '10px 0', borderTop: `1px solid ${T.border}`, flexWrap: 'wrap' }}>
                      <div style={{ width: '7px', height: '7px', borderRadius: '50%', background: r.channelState === 'open' ? T.green : r.channelState === 'error' ? T.red : T.dim, flexShrink: 0 }} />
                      <span style={{ flex: 1, fontSize: '13px', minWidth: '80px' }}>{r.displayName}</span>
                      {r.sendProgress && r.sendProgress.percent < 100 && (
                        <div style={{ flex: 1, minWidth: '100px' }}>
                          <ProgressBar percent={r.sendProgress.percent} />
                          <div style={{ fontSize: '11px', color: T.muted, marginTop: '2px' }}>{r.sendProgress.currentFile ?? 'Sending...'} {r.sendProgress.percent}%</div>
                        </div>
                      )}
                      {r.lastSentAt && !r.sendProgress && <span style={{ fontSize: '11px', color: T.muted }}>✓ {new Date(r.lastSentAt).toLocaleTimeString()}</span>}
                      <Btn small primary onClick={() => handleSendTo(r.peerId)} disabled={r.channelState !== 'open' || !hasPayload}>Send</Btn>
                    </div>
                  ))}
                </>
              )}
            </Card>
          </div>
        )}

        {view === 'join' && storedPayload && (
          <div className="fade-in">
            <Card style={{ textAlign: 'center', padding: '20px' }}>
              <div style={{ fontSize: '11px', letterSpacing: '2px', textTransform: 'uppercase', color: T.green, marginBottom: '8px' }}>✓ Received</div>
              <div style={{ fontFamily: T.mono, fontSize: '32px', fontWeight: 500, letterSpacing: '8px', color: T.accent }}>{code}</div>
              {countdown && <div style={{ marginTop: '8px', fontSize: '12px', color: countdown === 'Expired' ? T.red : T.muted }}>{countdown === 'Expired' ? '⚠ Expired' : `Valid for ${countdown}`}</div>}
            </Card>
            {storedPayload.text && (
              <Card>
                <div style={{ fontSize: '12px', color: T.muted, marginBottom: '8px' }}>Text</div>
                <div style={{ whiteSpace: 'pre-wrap', fontSize: '14px', lineHeight: 1.65, background: T.bg, padding: '12px', borderRadius: T.radiusSm }}>{storedPayload.text}</div>
              </Card>
            )}
            {storedPayload.files.length > 0 && (
              <Card>
                <div style={{ fontSize: '12px', color: T.muted, marginBottom: '10px' }}>Files</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                  {storedPayload.files.map((f, i) => (
                    <div key={i} style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                      <span style={{ flex: 1, fontSize: '13px', minWidth: '80px' }}>{f.name}</span>
                      <span style={{ fontSize: '11px', color: T.muted, flexShrink: 0 }}>{formatBytes(f.size)}</span>
                      <div style={{ display: 'flex', gap: '6px' }}>
                        <Btn small onClick={() => handleStoredPreview(f)}>Preview</Btn>
                        <Btn small primary onClick={() => handleStoredDownload(f)}>Download</Btn>
                      </div>
                    </div>
                  ))}
                </div>
              </Card>
            )}
          </div>
        )}

        {view === 'join' && !storedPayload && channelState !== 'open' && channelState !== 'error' && (
          <Card className="fade-in" style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <Spinner /><span style={{ fontSize: '13px', color: T.muted }}>Connecting to live session...</span>
          </Card>
        )}

        {view === 'join' && !storedPayload && channelState === 'error' && !transferError && (
          <Card className="fade-in" style={{ borderColor: T.red }}>
            <div style={{ color: T.red, marginBottom: '8px', fontWeight: 500 }}>✕ Connection failed</div>
            <div style={{ fontSize: '13px', color: T.muted, lineHeight: 1.55 }}>Could not establish a direct connection. This usually happens on restricted networks. Try switching to WiFi or ask the sender to try from a different network.</div>
          </Card>
        )}

        {view === 'join' && !storedPayload && channelState === 'open' && !received && !recvProgress && !transferError && (
          <Card className="fade-in" style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <span style={{ animation: 'pulse 2s infinite', fontSize: '16px' }}>⋯</span>
            <span style={{ fontSize: '13px', color: T.muted }}>Connected — waiting for sender...</span>
          </Card>
        )}

        {transferError && !received && (
          <Card className="fade-in" style={{ borderColor: T.red }}>
            <div style={{ color: T.red, marginBottom: '6px', fontWeight: 500 }}>✕ Transfer failed</div>
            <div style={{ fontSize: '13px', color: T.muted }}>{transferError}</div>
          </Card>
        )}

        {recvProgress && recvProgress.percent < 100 && !received && (
          <Card className="fade-in">
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px' }}>
              <span style={{ fontSize: '13px' }}>{recvProgress.currentFile ?? 'Receiving...'}</span>
              <span style={{ fontFamily: T.mono, fontSize: '13px', color: T.accent }}>{recvProgress.percent}%</span>
            </div>
            <ProgressBar percent={recvProgress.percent} />
            <div style={{ marginTop: '6px', fontSize: '11px', color: T.muted }}>{formatBytes(recvProgress.bytesDone)} / {formatBytes(recvProgress.bytesTotal)}</div>
          </Card>
        )}

        {received && (
          <div className="fade-in">
            <Card style={{ textAlign: 'center', padding: '18px' }}>
              <div style={{ fontSize: '11px', letterSpacing: '2px', textTransform: 'uppercase', color: T.green, marginBottom: '8px' }}>✓ Received</div>
              <div style={{ fontFamily: T.mono, fontSize: '32px', fontWeight: 500, letterSpacing: '8px', color: T.accent }}>{code}</div>
            </Card>
            {received.text && (
              <Card>
                <div style={{ fontSize: '12px', color: T.muted, marginBottom: '8px' }}>Text</div>
                <div style={{ whiteSpace: 'pre-wrap', fontSize: '14px', lineHeight: 1.65, background: T.bg, padding: '12px', borderRadius: T.radiusSm }}>{received.text}</div>
              </Card>
            )}
            {received.files.length > 0 && (
              <Card>
                <div style={{ fontSize: '12px', color: T.muted, marginBottom: '10px' }}>Files</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                  {received.files.map((f, i) => (
                    <div key={i} style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                      <span style={{ flex: 1, fontSize: '13px', minWidth: '80px' }}>{f.name}</span>
                      <span style={{ fontSize: '11px', color: T.muted, flexShrink: 0 }}>{formatBytes(f.blob.size)}</span>
                      <div style={{ display: 'flex', gap: '6px' }}>
                        <Btn small onClick={() => handleLivePreview(f)}>Preview</Btn>
                        <Btn small primary onClick={() => handleLiveDownload(f)}>Download</Btn>
                      </div>
                    </div>
                  ))}
                </div>
              </Card>
            )}
          </div>
        )}

        {(view !== 'home' || publishedMode) && (
          <div style={{ marginTop: '8px' }}>
            <Btn small onClick={reset} style={{ color: T.muted }}>← New session</Btn>
          </div>
        )}

      </div>
    </>
  )
}

function Card({ children, style, className }: { children: React.ReactNode; style?: React.CSSProperties; className?: string }) {
  return (
    <div className={className} style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: T.radius, padding: '16px', marginBottom: '12px', ...style }}>
      {children}
    </div>
  )
}

function Pill({ children }: { children: React.ReactNode; key?: unknown }) {
  return (
    <div style={{ display: 'inline-flex', alignItems: 'center', gap: '5px', background: T.bg, border: `1px solid ${T.border}`, borderRadius: T.radiusSm, padding: '3px 8px', fontSize: '12px' }}>
      {children}
    </div>
  )
}

function Btn({ children, primary, small, disabled, onClick, style, className }: {
  children: React.ReactNode; primary?: boolean; small?: boolean
  disabled?: boolean; onClick?: () => void; style?: React.CSSProperties; className?: string
}) {
  return (
    <button onClick={onClick} disabled={disabled} className={className} style={{
      padding: small ? '7px 14px' : '10px 20px', fontSize: small ? '12px' : '14px', fontWeight: 500,
      border: primary ? 'none' : `1px solid ${T.borderHi}`, borderRadius: T.radiusSm,
      background: primary ? (disabled ? T.accentDim : T.accent) : 'transparent',
      color: primary ? (disabled ? T.muted : '#000') : T.text,
      opacity: disabled ? 0.5 : 1, cursor: disabled ? 'not-allowed' : 'pointer',
      display: 'inline-flex', alignItems: 'center', gap: '6px', justifyContent: 'center',
      minHeight: small ? '36px' : '44px', transition: 'opacity 0.15s', ...style,
    }}>
      {children}
    </button>
  )
}

function ProgressBar({ percent }: { percent: number }) {
  return (
    <div style={{ height: '4px', background: T.dim, borderRadius: '2px', overflow: 'hidden' }}>
      <div style={{ height: '100%', width: `${percent}%`, background: T.accent, transition: 'width 0.1s' }} />
    </div>
  )
}

function Spinner() {
  return <div style={{ width: '14px', height: '14px', border: `2px solid ${T.dim}`, borderTopColor: T.accent, borderRadius: '50%', animation: 'spin 0.7s linear infinite', flexShrink: 0 }} />
}

function iStyle(extra?: React.CSSProperties): React.CSSProperties {
  return { background: T.bg, border: `1px solid ${T.border}`, borderRadius: T.radiusSm, color: T.text, padding: '10px 12px', fontSize: '14px', outline: 'none', ...extra }
}
