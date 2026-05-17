import { useState, useRef, useEffect, useCallback } from 'react'
import { QRCodeSVG } from 'qrcode.react'
import { SignalingClient } from './lib/signalingClient'
import { WebRTCManager, type ChannelState } from './lib/webrtc'
import { TransferReceiver, sendTransfer, type TransferProgress, type ReceivedTransfer, type ReceivedFile } from './lib/transfer'
import { encrypt, decrypt, arrayBufferToBase64, base64ToArrayBuffer } from './lib/crypto'
import type { SignalMessage, PeerRole } from './types'

const API_URL = import.meta.env.VITE_API_URL as string
const SIGNALING_URL = API_URL.startsWith('https')
  ? API_URL.replace('https', 'wss')
  : API_URL.replace('http', 'ws')
const STORED_TTL_MIN = 1 * 60
const STORED_TTL_MAX = 10 * 60 * 60
const STORED_MAX = 10 * 1024 * 1024

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

function formatSpeed(bps: number): string {
  if (bps > 1024 * 1024) return `${(bps / 1024 / 1024).toFixed(1)} MB/s`
  if (bps > 1024) return `${(bps / 1024).toFixed(1)} KB/s`
  return `${Math.round(bps)} B/s`
}

function formatRemaining(seconds: number): string {
  if (seconds > 3600) return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`
  if (seconds > 60) return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`
  return `${Math.round(seconds)}s`
}

function getTextBytes(text: string): number {
  return new TextEncoder().encode(text).length
}

function splitStoredTtl(seconds: number): { hours: number; minutes: number } {
  const clamped = Math.min(Math.max(seconds, STORED_TTL_MIN), STORED_TTL_MAX)
  const h = Math.floor(clamped / 3600)
  const m = Math.round((clamped % 3600) / 60)
  return { hours: h, minutes: m }
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
  peerId: string; rtc: WebRTCManager
  channelState: ChannelState; sendProgress: TransferProgress | null; lastSentAt: number | null
}




export default function App() {
  const [view, setView] = useState<'home' | 'publish' | 'join'>('home')
  const [code, setCode] = useState('')
  const [inputCode, setInputCode] = useState('')
  const [text, setText] = useState('')
  const [files, setFiles] = useState<File[]>([])
  const [ttlSeconds, setTtlSeconds] = useState(3600)
  const [publishing, setPublishing] = useState(false)
  const [publishedMode, setPublishedMode] = useState<PublishMode | null>(null)
  const [expiresAt, setExpiresAt] = useState<number | null>(null)
  const [copiedCode, setCopiedCode] = useState(false)
  const [copiedLink, setCopiedLink] = useState(false)
  const [copiedPassword, setCopiedPassword] = useState(false)
  const [showPassword, setShowPassword] = useState(false)
  const [sigState, setSigState] = useState('disconnected')
  const [recipients, setRecipients] = useState<RecipientConn[]>([])
  const [channelState, setChannelState] = useState<ChannelState>('idle')
  const [recvProgress, setRecvProgress] = useState<TransferProgress | null>(null)
  const [received, setReceived] = useState<ReceivedTransfer | null>(null)
  const [storedPayload, setStoredPayload] = useState<RetrievedPayload | null>(null)
  const [joining, setJoining] = useState(false)
  const [joinError, setJoinError] = useState('')
  const [countdown, setCountdown] = useState('')
  const [storedEnabled, setStoredEnabled] = useState(true)
  const [publishError, setPublishError] = useState('')
  const [password, setPassword] = useState('')
  const [inputPassword, setInputPassword] = useState('')
  const [burnOnRead, setBurnOnRead] = useState(false)
  const [isStorageFull, setIsStorageFull] = useState(false)
  const [theme, setTheme] = useState<'dark' | 'light'>(() => (localStorage.getItem('qs_theme') as any) || 'dark')

  const sigRef = useRef<SignalingClient | null>(null)
  const rtcMapRef = useRef<Map<string, WebRTCManager>>(new Map())
  const rtcRef = useRef<WebRTCManager | null>(null)
  const receiverRef = useRef<TransferReceiver | null>(null)
  const recipientCountRef = useRef(0)
  const p2pEverLiveRef = useRef(false)
  const iceServersRef = useRef<RTCIceServer[]>([])
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const linkTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const passwordTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (!expiresAt) { setCountdown(''); return }
    const tick = () => setCountdown(formatCountdown(expiresAt - Date.now()))
    tick()
    const id = setInterval(tick, 1000)
    return () => clearInterval(id)
  }, [expiresAt])

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
    localStorage.setItem('qs_theme', theme)
  }, [theme])

  // Prevent accidental reloads during active live sessions
  useEffect(() => {
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      if (publishedMode === 'live' && sigState === 'connected') {
        e.preventDefault()
        e.returnValue = ''
      }
    }
    window.addEventListener('beforeunload', handleBeforeUnload)
    return () => window.removeEventListener('beforeunload', handleBeforeUnload)
  }, [publishedMode, sigState])

  useEffect(() => {
    const path = window.location.pathname.replace(/^\//, '').trim()
    if (/^\d{6}$/.test(path)) {
      setInputCode(path)
      window.history.replaceState(null, '', '/')
    }
  }, [])

  useEffect(() => {
    // Initial health check to verify if stored mode is supported by the server.
    const checkStatus = async () => {
      try {
        const r = await fetch(`${API_URL}/health`)
        const data = await r.json()
        if (typeof data.storedModeEnabled === 'boolean') {
          setStoredEnabled(data.storedModeEnabled)
        }
        if (typeof data.isStorageFull === 'boolean') {
          setIsStorageFull(data.isStorageFull)
        }
      } catch (err) {
        setStoredEnabled(true)
      }
    }
    checkStatus()
  }, [])

  const totalBytes = files.reduce((s, f) => s + f.size, 0)
  const textBytes = getTextBytes(text)
  const payloadBytes = totalBytes + textBytes
  const mode: PublishMode =
    publishedMode === 'stored' ? 'stored' :
      publishedMode === 'live' ? 'live' :
        (!storedEnabled) ? 'live' :
        (payloadBytes <= STORED_MAX) ? 'stored' : 'live'

  const effectiveMode = mode
  const hasPayload = text.trim().length > 0 || files.length > 0

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

  function copyLink() {
    if (!code) return
    const url = `${window.location.origin}/${code}`
    navigator.clipboard.writeText(url).catch(() => {
      const el = document.createElement('textarea')
      el.value = url
      document.body.appendChild(el)
      el.select()
      document.execCommand('copy')
      document.body.removeChild(el)
    })
    setCopiedLink(true)
    if (linkTimerRef.current) clearTimeout(linkTimerRef.current)
    linkTimerRef.current = setTimeout(() => setCopiedLink(false), 2000)
  }

  function copyPassword() {
    if (!password) return
    navigator.clipboard.writeText(password).catch(() => {
      const el = document.createElement('textarea')
      el.value = password
      document.body.appendChild(el)
      el.select()
      document.execCommand('copy')
      document.body.removeChild(el)
    })
    setCopiedPassword(true)
    if (passwordTimerRef.current) clearTimeout(passwordTimerRef.current)
    passwordTimerRef.current = setTimeout(() => setCopiedPassword(false), 2000)
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
    const hours = Number.isFinite(hoursValue) ? Math.max(0, Math.min(10, Math.trunc(hoursValue))) : 0
    const minutes = Number.isFinite(minutesValue) ? Math.max(0, Math.min(59, Math.trunc(minutesValue))) : 0

    const totalSeconds = (hours * 3600) + (minutes * 60)
    setTtlSeconds(clampStoredTtl(totalSeconds))
  }

  async function handleStoredPublish() {
    if (!hasPayload) return
    if (!storedEnabled) {
      setPublishError('Stored mode requires MongoDB. Set MONGODB_URI and restart the server.')
      return
    }
    setPublishing(true)
    setPublishError('')
    const isUpdate = publishedMode === 'stored' && code !== ''
    try {
      const form = new FormData()
      
      // E2EE: Encrypt text if password is set
      let finalText = text
      if (password) {
        const encryptedText = await encrypt(text, password)
        finalText = arrayBufferToBase64(encryptedText)
      }
      form.append('text', finalText)
      form.append('ttlMs', String(clampStoredTtl(ttlSeconds) * 1000))
      if (password) form.append('password', password)
      form.append('burnOnRead', String(burnOnRead))
      
      // E2EE: Encrypt each file if password is set
      for (const f of files) {
        if (password) {
          const buffer = await f.arrayBuffer()
          const encrypted = await encrypt(buffer, password)
          form.append('files', new Blob([encrypted]), f.name)
        } else {
          form.append('files', f)
        }
      }
      
      const url = isUpdate ? `${API_URL}/publish/${code}` : `${API_URL}/publish`
      const method = isUpdate ? 'PATCH' : 'POST'

      const data = await new Promise<{ code: string; expiresAt: number; mode: string; error?: string }>((resolve, reject) => {
        const xhr = new XMLHttpRequest()
        xhr.open(method, url)
        if (password) {
          xhr.setRequestHeader('x-session-password', password)
        }
        if (files.length > 0) {
          xhr.upload.onprogress = () => {}
        }
        xhr.onload = () => {
          try {
            const resp = JSON.parse(xhr.responseText)
            if (xhr.status >= 400) resolve({ error: resp.error || 'Request failed', ...resp })
            else resolve(resp)
          } catch (e) {
            reject(new Error('Invalid response from server'))
          }
        }
        xhr.onerror = () => reject(new Error('Network error. The server might be offline or unreachable.'))
        xhr.ontimeout = () => reject(new Error('Upload timed out. Please try a smaller file or a faster connection.'))
        xhr.send(form)
      })

      if (data.error) {
        setPublishError(data.error.includes('not found') ? 'Session not found.' : data.error)
        if (data.error.includes('not found') && isUpdate) { setCode(''); setPublishedMode(null) }
        setPublishing(false)
        return
      }
      setCode(data.code)
      setExpiresAt(data.expiresAt)
      setPublishedMode('stored')
    } catch (err: any) {
      setPublishError(err?.message ?? 'An unexpected error occurred.')
    }
    setPublishing(false)
  }

  async function handleLivePublish() {
    setPublishing(true)
    setPublishError('')
    await fetchIceServers()
    try {
      const res = await fetch(`${API_URL}/session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ttlMs: 24 * 60 * 60 * 1000, password })
      })
      const data = await res.json()
      if (!res.ok) {
        setPublishError(data.error || 'Could not complete publish.')
        setPublishing(false)
        return
      }
      setCode(data.code)
      setPublishedMode('live')
      setExpiresAt(data.expiresAt)
      startSignaling(data.code, 'publisher')
    } catch (err: any) {
      setPublishError('Could not connect to server. Please try again.')
    }
    setPublishing(false)
  }

  async function handleSendTo(peerId: string, providedRtc?: WebRTCManager) {
    if (!hasPayload) return
    const rtc = providedRtc || rtcMapRef.current.get(peerId)
    if (!rtc || rtc.getDataChannel()?.readyState !== 'open') return

    setRecipients(prev => prev.map(x => x.peerId === peerId ? { ...x, sendProgress: null } : x))
    try {
      await sendTransfer(rtc, text, files, p => {
        setRecipients(prev => prev.map(x => x.peerId === peerId ? { ...x, sendProgress: p } : x))
      })
      setRecipients(prev => prev.map(x => x.peerId === peerId ? { ...x, lastSentAt: Date.now(), sendProgress: null } : x))
    } catch (err) {
      alert('Connection issue. Please try again.')
    }
  }


  async function handleJoin() {
    if (inputCode.length !== 6 || !inputPassword) return
    setJoining(true)
    setJoinError('')
    try {
      const headers: any = {}
      if (inputPassword) headers['x-session-password'] = inputPassword

      const res = await fetch(`${API_URL}/retrieve/${inputCode}`, { headers })
      if (res.ok) {
        const data: RetrievedPayload = await res.json()
        
        // E2EE: Decrypt text if password was used
        if (inputPassword && data.text) {
          try {
            data.text = await decrypt(base64ToArrayBuffer(data.text), inputPassword, true) as string
          } catch (e) {
            setJoinError('Unable to decrypt the message.')
          }
        }
        
        setStoredPayload(data)
        setCode(inputCode)
        setExpiresAt(data.expiresAt)
        setView('join')
        setJoining(false)
        return
      }
      if (res.status === 401) {
        setJoinError('Invalid password. Please try again.')
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
      const data = await res.json().catch(() => ({}))
      setJoinError(data.error || 'Could not join session.')
    } catch (err: any) {
      setJoinError('Server not connected.')
    }
    setJoining(false)
  }

  function handleStoredDownload(f: StoredFileInfo) {
    const url = `${API_URL}/file/${f.fileId}/${f.token}`
    const headers: any = {}
    if (inputPassword) headers['x-session-password'] = inputPassword

    // Download should always save the file instead of opening a preview.
    fetch(url, { headers })
      .then(res => {
        if (!res.ok) throw new Error()
        return res.blob()
      })
      .then(async blob => {
        let finalBlob = blob
        if (inputPassword) {
          try {
            const buffer = await blob.arrayBuffer()
            const decrypted = await decrypt(buffer, inputPassword, false) as ArrayBuffer
            finalBlob = new Blob([decrypted], { type: f.mimeType })
          } catch (e) {
            alert('Unable to open the file.')
            return
          }
        }
        const u = URL.createObjectURL(finalBlob)
        anchorDownload(u, f.name)
        setTimeout(() => URL.revokeObjectURL(u), 1000)
      })
      .catch(() => alert('Failed to download file. Check password or connection.'))
  }

  function handleStoredPreview(f: StoredFileInfo) {
    const headers: any = {}
    if (inputPassword) headers['x-session-password'] = inputPassword

    fetch(`${API_URL}/file/${f.fileId}/${f.token}`, { headers })
      .then(res => {
        if (!res.ok) throw new Error()
        return res.blob()
      })
      .then(async blob => {
        let finalBlob = blob
        if (inputPassword) {
          try {
            const buffer = await blob.arrayBuffer()
            const decrypted = await decrypt(buffer, inputPassword, false) as ArrayBuffer
            finalBlob = new Blob([decrypted], { type: f.mimeType })
          } catch (e) {
            alert('Unable to open the file.')
            return
          }
        }
        const u = URL.createObjectURL(finalBlob)
        window.open(u, '_blank', 'noopener')
        setTimeout(() => URL.revokeObjectURL(u), 60000)
      })
      .catch(() => alert('Server not connected.'))
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
      const res = await fetch(`${API_URL}/ice-servers`)
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
      password: sessionRole === 'recipient' ? inputPassword : password,
      onOpen: () => setSigState('connected'),
      onClose: () => setSigState('disconnected'),
      onError: () => { },
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
      if (typeof msg.payload === 'string' && msg.payload === 'invalid_password') {
        setJoinError('Invalid session password.')
        sig.disconnect()
        setSigState('disconnected')
        setView('home') // Go back to enter password again
        return
      }
      if (typeof msg.payload === 'string' && msg.payload.startsWith('Waiting for publisher')) return
      if (typeof msg.payload === 'string' && msg.payload.startsWith('Session not found')) {
        if (p2pEverLiveRef.current) { sigRef.current?.disconnect(); setSigState('offline') }
        else {
          setJoinError('Session not found or expired.')
          setSigState('lost')
          setView('home')
        }
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
        const rtc = new WebRTCManager({
          role: 'publisher', peerId, signalingClient: sig,
          iceServers: iceServersRef.current.length > 0 ? iceServersRef.current : undefined,
          onChannelStateChange: state => {
            if (state === 'open') {
              p2pEverLiveRef.current = true
              handleSendTo(peerId, rtc) // AUTO-TRANSFER immediately on open
            }
            setRecipients(prev => prev.map(r => r.peerId === peerId ? { ...r, channelState: state } : r))
          },
        })
        rtcMapRef.current.set(peerId, rtc)
        setRecipients(prev => {
          const filtered = prev.filter(r => r.peerId !== peerId)
          return [...filtered, { peerId, rtc, channelState: 'idle', sendProgress: null, lastSentAt: null }]
        })
        await rtc.start()
      } else {
        await fetchIceServers()
        if (rtcRef.current) rtcRef.current.close()
        const receiver = new TransferReceiver(
          p => setRecvProgress(p),
          result => { setReceived(result); setRecvProgress(null) },
          reason => { setJoinError(reason); setRecvProgress(null) }
        )
        receiverRef.current = receiver
        const rtc = new WebRTCManager({
          role: 'recipient', peerId, signalingClient: sig,
          iceServers: iceServersRef.current.length > 0 ? iceServersRef.current : undefined,
          onChannelStateChange: state => {
            if (state === 'open') p2pEverLiveRef.current = true
            setChannelState(state)
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
    setCopiedCode(false)
    setSigState('disconnected'); setRecipients([])
    setChannelState('idle'); setRecvProgress(null)
    setReceived(null); setStoredPayload(null)
    setJoining(false); setJoinError('')
    setCountdown(''); setPassword(''); setInputPassword('')
  }

  function sigColor() {
    if (['failed', 'lost', 'expired'].includes(sigState)) return 'var(--error)'
    if (sigState.startsWith('reconnecting') || sigState === 'offline') return 'var(--warning)'
    if (sigState === 'connected') return 'var(--success)'
    return 'var(--text-dim)'
  }

  function sigLabel() {
    if (sigState === 'connected') return 'Connected'
    if (sigState === 'disconnected') return 'Disconnected'
    if (sigState === 'lost') return 'Session Lost'
    if (sigState === 'offline') return 'Offline'
    if (sigState === 'expired') return 'Expired'
    if (sigState.startsWith('reconnecting')) return 'Reconnecting...'
    return sigState
  }

  function channelLabel(state: ChannelState) {
    if (state === 'open') return 'Live'
    if (state === 'connecting') return 'Connecting...'
    if (state === 'idle') return sigState === 'connected' ? 'Connected, waiting for sender...' : 'Waiting...'
    if (state === 'error') return 'Error'
    return state
  }

  const qrUrl = `${window.location.origin}/${code}`

  return (
    <div className="container animate-fade">
      <header>
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: '1rem' }}>
          <button
            onClick={() => setTheme(t => t === 'dark' ? 'light' : 'dark')}
            className="btn btn-secondary"
            style={{ padding: '8px', borderRadius: '50%', width: '40px', height: '40px' }}
          >
            <Icon name={theme === 'dark' ? 'sun' : 'moon'} size={18} />
          </button>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '12px', marginBottom: '1rem' }}>
          <Icon name="rocket" size={32} style={{ color: 'var(--accent)' }} />
          <h1>QuickShare</h1>
        </div>
        <p className="subtitle">Instant, secure, peer-to-peer file sharing</p>
      </header>

      {view === 'home' && !publishedMode && (
        <section className="animate-fade">
          <div style={{ textAlign: 'center', marginBottom: '3rem' }}>
            <Btn onClick={() => setView('publish')} primary style={{ padding: '1rem 2.5rem' }}>
              <Icon name="zap" size={18} />
              Start New Session
            </Btn>
          </div>

          <Card>
            <div style={{ marginBottom: '1.5rem' }}>
              <label style={{ display: 'block', fontSize: '0.75rem', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.1em', color: 'var(--text-dim)', marginBottom: '0.75rem' }}>Join Session</label>
              <div style={{ display: 'flex', gap: '12px' }}>
                <input
                  className="input"
                  type="text"
                  placeholder="000000"
                  value={inputCode}
                  onChange={e => setInputCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                  onKeyDown={e => e.key === 'Enter' && handleJoin()}
                  style={{ textAlign: 'center', fontSize: '1.25rem', fontWeight: 700, letterSpacing: '0.2em', fontFamily: 'var(--font-mono)' }}
                />
                <Btn primary disabled={inputCode.length !== 6 || !inputPassword || joining} onClick={handleJoin} style={{ width: '80px' }}>
                  {joining ? <Spinner /> : 'Join'}
                </Btn>
              </div>
            </div>

            <div className="animate-fade">
              <label style={{ display: 'block', fontSize: '0.75rem', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.1em', color: 'var(--text-dim)', marginBottom: '0.75rem' }}>Session Password</label>
              <div style={{ position: 'relative' }}>
                <input
                  className="input"
                  type="password"
                  placeholder="Required for security"
                  value={inputPassword}
                  onChange={e => setInputPassword(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && handleJoin()}
                  style={{ paddingLeft: '2.5rem' }}
                />
                <Icon name="lock" size={16} style={{ position: 'absolute', left: '12px', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-dim)' }} />
              </div>
            </div>

            {joinError && (
              <div style={{ marginTop: '1.25rem', color: 'var(--error)', fontSize: '0.875rem', fontWeight: 500, display: 'flex', alignItems: 'center', gap: '8px' }}>
                <Icon name="shield" size={14} />
                {joinError}
              </div>
            )}
          </Card>
        </section>
      )}

      {view === 'publish' && !publishedMode && (
        <section className="animate-fade">
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '2rem' }}>
            <Btn small onClick={() => setView('home')}>← Home</Btn>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <Icon name="cloud" size={16} style={{ color: 'var(--accent)' }} />
              <span style={{ fontSize: '0.875rem', fontWeight: 600 }}>Create Session</span>
            </div>
          </div>

          <Card>
            <label style={{ display: 'block', fontSize: '0.75rem', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.1em', color: 'var(--text-dim)', marginBottom: '0.75rem' }}>Content</label>
            <textarea
              className="input"
              style={{ minHeight: '120px', resize: 'vertical', marginBottom: '1.5rem' }}
              placeholder="Paste links, text snippets, or markdown..."
              value={text}
              onChange={e => setText(e.target.value)}
            />

            <div style={{ position: 'relative', borderRadius: 'var(--radius)', border: '2px dashed var(--border)', padding: '1.5rem', textAlign: 'center' }}>
              <input type="file" multiple onChange={handleFileChange} style={{ position: 'absolute', inset: 0, opacity: 0, cursor: 'pointer' }} />
              <Icon name="file" size={24} style={{ color: 'var(--accent)', marginBottom: '8px' }} />
              <p style={{ fontSize: '0.875rem', fontWeight: 500 }}>Drop files here or click to browse</p>
              <p style={{ fontSize: '0.75rem', color: 'var(--text-dim)', marginTop: '4px' }}>Max 100MB per file</p>
            </div>
            {files.length > 0 && <FilePills fileList={files} onRemove={i => setFiles(prev => prev.filter((_, j) => j !== i))} />}
          </Card>

          <Card>
            <div style={{ marginBottom: '1.5rem' }}>
              <label style={{ display: 'block', fontSize: '0.75rem', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.1em', color: 'var(--text-dim)', marginBottom: '0.75rem' }}>Security</label>
              <div style={{ position: 'relative' }}>
                <input
                  className="input"
                  type="password"
                  placeholder="Set session password"
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  style={{ paddingLeft: '2.5rem' }}
                />
                <Icon name="lock" size={16} style={{ position: 'absolute', left: '12px', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-dim)' }} />
              </div>
              
              {effectiveMode === 'stored' && (
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', marginTop: '1rem' }} onClick={() => setBurnOnRead(!burnOnRead)}>
                  <div style={{ 
                    width: '32px', height: '18px', background: burnOnRead ? 'var(--accent)' : 'var(--border)', 
                    borderRadius: '100px', position: 'relative', transition: 'var(--transition)' 
                  }}>
                    <div style={{ 
                      width: '12px', height: '12px', background: '#fff', borderRadius: '50%', 
                      position: 'absolute', top: '3px', left: burnOnRead ? '17px' : '3px', transition: 'var(--transition)' 
                    }} />
                  </div>
                  <span style={{ fontSize: '0.8125rem', fontWeight: 600 }}>Burn after first retrieval</span>
                </div>
              )}
            </div>
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: '12px', padding: '1rem', background: 'var(--surface-hi)', borderRadius: 'var(--radius)' }}>
              <Icon name={effectiveMode === 'stored' ? 'cloud' : 'zap'} size={20} style={{ color: 'var(--accent)', marginTop: '2px' }} />
              <div style={{ flex: 1 }}>
                <p style={{ fontSize: '0.875rem', fontWeight: 700, marginBottom: '2px' }}>
                  {effectiveMode === 'stored' ? 'Cloud Storage' : 'Live P2P'}
                </p>
                <p style={{ fontSize: '0.75rem', color: 'var(--text-dim)', lineHeight: '1.4' }}>
                  {effectiveMode === 'stored' 
                    ? 'Encrypted on our servers. Access anytime until expiry.' 
                    : 'Direct device-to-device. Keep this tab open to transfer.'}
                </p>
                {!storedEnabled && !publishedMode && !isStorageFull && (
                  <p style={{ marginTop: '0.5rem', fontSize: '0.75rem', color: 'var(--warning, #eab308)', lineHeight: '1.4' }}>
                    Cloud storage is currently unavailable. Falling back to Live P2P mode.
                  </p>
                )}
                {isStorageFull && !publishedMode && (
                  <p style={{ marginTop: '0.5rem', fontSize: '0.75rem', color: 'var(--warning, #eab308)', lineHeight: '1.4' }}>
                    Cloud storage is not available for now. The website is in update.
                  </p>
                )}
              </div>
            </div>
            {effectiveMode === 'stored' && (
              <div style={{ marginTop: '1rem' }}>
                <DurationPicker ttlSeconds={ttlSeconds} setStoredDuration={setStoredDuration} />
              </div>
            )}
          </Card>

          <Btn
            primary
            onClick={() => effectiveMode === 'stored' ? handleStoredPublish() : handleLivePublish()}
            disabled={!hasPayload || publishing || !password}
            style={{ width: '100%', height: '52px' }}
          >
            {publishing ? <Spinner /> : 'Launch Session'}
          </Btn>

          {publishError && <div style={{ marginTop: '1rem', color: 'var(--error)', textAlign: 'center', fontSize: '0.9rem' }}>{publishError}</div>}
        </section>
      )}

      {(publishedMode === 'stored' || publishedMode === 'live') && (
        <section className="animate-fade">
          <Card style={{ textAlign: 'center' }}>
            <label style={{ display: 'block', fontSize: '0.75rem', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.1em', color: 'var(--text-dim)', marginBottom: '1.5rem' }}>Session Live</label>
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: '3.5rem', fontWeight: 800, letterSpacing: '0.1em', color: 'var(--text)', marginBottom: '1.5rem' }}>{code}</div>

            <div style={{ marginBottom: '1.5rem', padding: '1rem', borderRadius: 'var(--radius)', background: 'var(--bg)', border: '1px solid var(--border)', textAlign: 'left' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px' }}>
                <div>
                  <label style={{ display: 'block', fontSize: '0.7rem', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--text-dim)', marginBottom: '0.35rem' }}>Sender Password</label>
                  <div style={{ fontFamily: 'var(--font-mono)', fontSize: '0.95rem', color: 'var(--text)' }}>
                    {showPassword ? password : '••••••••'}
                  </div>
                </div>
                <div style={{ display: 'flex', gap: '8px', flexShrink: 0 }}>
                  <Btn small onClick={() => setShowPassword(v => !v)} secondary>{showPassword ? 'Hide' : 'Show'}</Btn>
                  <Btn small onClick={copyPassword} secondary>{copiedPassword ? 'Copied' : 'Copy'}</Btn>
                </div>
              </div>
            </div>
            
            <div style={{ display: 'flex', gap: '12px', justifyContent: 'center', marginBottom: '2rem', flexWrap: 'wrap' }}>
              <Btn onClick={copyCode} style={{ flex: 1, minWidth: '130px' }}>
                <Icon name={copiedCode ? 'check' : 'copy'} size={16} />
                {copiedCode ? 'Copied' : 'Copy Code'}
              </Btn>
              <Btn onClick={copyLink} style={{ flex: 1, minWidth: '130px' }}>
                <Icon name={copiedLink ? 'check' : 'link'} size={16} />
                {copiedLink ? 'Link Copied' : 'Copy Link'}
              </Btn>
            </div>
            <Btn onClick={reset} style={{ width: '100%', marginBottom: '2rem' }} secondary>Launch New Session</Btn>

            <div style={{ background: '#fff', padding: '1.5rem', borderRadius: 'var(--radius)', display: 'inline-block', marginBottom: '1rem' }}>
              <QRCodeSVG value={qrUrl} size={160} level="H" />
            </div>
            <p style={{ fontSize: '0.75rem', color: 'var(--text-dim)' }}>Scan to join from another device</p>

            {countdown && publishedMode === 'stored' && (
              <div style={{ marginTop: '1.5rem', fontSize: '0.875rem', fontWeight: 600, color: 'var(--accent)', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px' }}>
                <Icon name="shield" size={14} />
                Expires in {countdown}
              </div>
            )}
          </Card>

          {publishedMode === 'live' && (
            <Card>
              <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '1.5rem' }}>
                <div style={{ width: '8px', height: '8px', borderRadius: '50%', background: sigColor() }} />
                <span style={{ fontSize: '0.875rem', fontWeight: 600, color: sigColor() }}>{sigLabel()}</span>
                <Icon name="zap" size={14} style={{ marginLeft: 'auto', color: 'var(--text-dim)' }} />
              </div>

              <div style={{ textAlign: 'center', padding: '1.5rem', background: 'var(--bg)', borderRadius: 'var(--radius)', border: '1px solid var(--border)' }}>
                <p style={{ fontSize: '1rem', fontWeight: 700, marginBottom: '0.5rem' }}>
                  {recipients.length === 0 ? 'Waiting for recipients...' : `${recipients.length} User(s) Connected`}
                </p>
                
                {recipients.length > 0 && (
                  <div style={{ marginTop: '1.5rem', textAlign: 'left' }}>
                    <label style={{ display: 'block', fontSize: '0.7rem', fontWeight: 800, textTransform: 'uppercase', color: 'var(--text-dim)', marginBottom: '1rem', letterSpacing: '0.05em' }}>Recipient Progress</label>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                      {recipients.map(r => (
                        <div key={r.peerId} style={{ padding: '0.75rem', background: 'var(--surface)', borderRadius: 'var(--radius)', border: '1px solid var(--border)' }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: r.sendProgress ? '8px' : '0' }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                              <div style={{ width: '6px', height: '6px', borderRadius: '50%', background: r.channelState === 'open' ? 'var(--success)' : 'var(--text-dim)' }} />
                              <span style={{ fontSize: '0.75rem', fontWeight: 600 }}>Peer {r.peerId.slice(0, 4)}</span>
                            </div>
                            <div style={{ textAlign: 'right' }}>
                              <div style={{ fontSize: '0.7rem', color: r.sendProgress ? 'var(--accent)' : 'var(--text-dim)', fontWeight: 600 }}>
                                {r.sendProgress ? `${r.sendProgress.percent}%` : r.lastSentAt ? 'Complete' : 'Idle'}
                              </div>
                              {r.sendProgress && r.sendProgress.speed && (
                                <div style={{ fontSize: '0.65rem', color: 'var(--text-dim)', marginTop: '2px' }}>
                                  {formatSpeed(r.sendProgress.speed)} • {formatRemaining(r.sendProgress.timeRemaining || 0)} left
                                </div>
                              )}
                            </div>
                          </div>
                          {r.sendProgress && <ProgressBar percent={r.sendProgress.percent} />}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </Card>
          )}

          <div style={{ marginTop: '1.5rem', textAlign: 'center' }}>
            <Btn onClick={reset} style={{ opacity: 0.6 }}>Create another session</Btn>
          </div>
        </section>
      )}

      {/* Recipient View */}
      {view === 'join' && (
        <section className="animate-fade">
          <Card style={{ textAlign: 'center' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', justifyContent: 'center', marginBottom: '1.5rem' }}>
              <Icon name={storedPayload ? 'cloud' : 'zap'} size={16} style={{ color: storedPayload ? 'var(--accent)' : (channelState === 'open' ? 'var(--success)' : 'var(--error)') }} />
              <span style={{ fontSize: '0.875rem', fontWeight: 600, color: 'var(--text-dim)' }}>
                {storedPayload ? 'Stored Session' : `P2P ${channelLabel(channelState)}`}
              </span>
            </div>
            
            <h2 style={{ fontSize: '1.5rem', fontWeight: 800, marginBottom: '2rem' }}>
              {recvProgress ? `Receiving... ${recvProgress.percent}%` : (storedPayload || received) ? 'Session Content' : 'Connecting...'}
            </h2>

            {recvProgress && (
              <div style={{ marginBottom: '2rem' }}>
                <ProgressBar percent={recvProgress.percent} />
                <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '0.75rem' }}>
                  <p style={{ fontSize: '0.8125rem', color: 'var(--text-dim)', fontWeight: 500 }}>
                    {recvProgress.currentFile}
                  </p>
                  {recvProgress.speed && (
                    <p style={{ fontSize: '0.8125rem', color: 'var(--accent)', fontWeight: 600 }}>
                      {formatSpeed(recvProgress.speed)} • {formatRemaining(recvProgress.timeRemaining || 0)}
                    </p>
                  )}
                </div>
              </div>
            )}

            {(storedPayload || received) ? (
              <div style={{ textAlign: 'left' }}>
                {(storedPayload?.text || received?.text) && (
                  <div style={{ marginBottom: '2rem' }}>
                    <label style={{ display: 'block', fontSize: '0.75rem', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.1em', color: 'var(--text-dim)', marginBottom: '0.75rem' }}>Message</label>
                    <div style={{ padding: '1.25rem', background: 'var(--bg)', borderRadius: 'var(--radius)', border: '1px solid var(--border)', whiteSpace: 'pre-wrap', fontSize: '0.95rem', lineHeight: '1.6' }}>
                      {storedPayload?.text || received?.text}
                    </div>
                  </div>
                )}

                {(storedPayload?.files?.length || received?.files?.length) && (
                  <div>
                    <label style={{ display: 'block', fontSize: '0.75rem', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.1em', color: 'var(--text-dim)', marginBottom: '0.75rem' }}>Files</label>
                    <div style={{ display: 'grid', gap: '12px' }}>
                      {(storedPayload?.files || received?.files || []).map((f, i) => (
                        <div key={i} style={{ display: 'flex', alignItems: 'center', gap: '12px', padding: '12px', background: 'var(--surface-hi)', borderRadius: 'var(--radius)', border: '1px solid var(--border)' }}>
                          <Icon name="file" size={18} style={{ color: 'var(--accent)' }} />
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <p style={{ fontSize: '0.875rem', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.name}</p>
                            {'size' in f && <p style={{ fontSize: '0.75rem', color: 'var(--text-dim)' }}>{formatBytes(f.size)}</p>}
                          </div>
                          <div style={{ display: 'flex', gap: '8px' }}>
                            <Btn small onClick={() => 'fileId' in f ? handleStoredPreview(f) : handleLivePreview(f)}>View</Btn>
                            <Btn small primary onClick={() => 'fileId' in f ? handleStoredDownload(f) : handleLiveDownload(f)}>Get</Btn>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            ) : !recvProgress && (
              <div style={{ padding: '2rem 0' }}>
                <Spinner style={{ width: '32px', height: '32px', margin: '0 auto', color: 'var(--accent)' }} />
              </div>
            )}
          </Card>
          
          <div style={{ textAlign: 'center', marginTop: '2rem' }}>
            <Btn onClick={reset} style={{ opacity: 0.7 }}>Exit Session</Btn>
          </div>
        </section>
      )}
    </div>
  )
}

// ── Sub-Components (Defined outside App to prevent re-mounts) ─────────────────

function DurationPicker({ ttlSeconds, setStoredDuration }: { ttlSeconds: number, setStoredDuration: (h: number, m: number) => void }) {
  const parts = splitStoredTtl(ttlSeconds)

  return (
    <div style={{ marginTop: '1rem', padding: '1rem', background: 'var(--surface-hi)', borderRadius: 'var(--radius)', border: '1px solid var(--border)' }}>
      <div style={{ fontSize: '0.75rem', color: 'var(--text-dim)', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: '1rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          <Icon name="shield" size={14} />
          <span>Session Expiry</span>
        </div>
        <span style={{ color: 'var(--accent)' }}>{formatTTL(ttlSeconds)}</span>
      </div>
      <div style={{ display: 'flex', gap: '1rem', alignItems: 'center', flexWrap: 'wrap' }}>
        <Stepper
          value={parts.hours} min={0} max={10} label="hr"
          onUpdate={v => setStoredDuration(v, parts.minutes)}
        />
        <Stepper
          value={parts.minutes} min={0} max={59} label="min"
          onUpdate={v => setStoredDuration(parts.hours, v)}
        />
      </div>
    </div>
  )
}

function Stepper({ value, min, max, label, onUpdate }: {
  value: number, min: number, max: number, label: string, onUpdate: (v: number) => void
}) {
  const timerRef = useRef<any>(null)
  const intervalRef = useRef<any>(null)

  const startChange = (delta: number) => {
    onUpdate(Math.min(max, Math.max(min, value + delta)))
    timerRef.current = setTimeout(() => {
      intervalRef.current = setInterval(() => {
        onUpdate(Math.min(max, Math.max(min, value + delta)))
      }, 80)
    }, 400)
  }

  const stopChange = () => {
    if (timerRef.current) clearTimeout(timerRef.current)
    if (intervalRef.current) clearInterval(intervalRef.current)
  }

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
      <button
        className="btn btn-secondary"
        style={{ width: '32px', height: '32px', padding: 0 }}
        onMouseDown={() => startChange(-1)} onMouseUp={stopChange} onMouseLeave={stopChange}
        onTouchStart={() => startChange(-1)} onTouchEnd={stopChange}
      >−</button>
      <div style={{ width: '32px', textAlign: 'center', fontSize: '1rem', fontWeight: 700, fontFamily: 'var(--font-mono)' }}>
        {String(value).padStart(2, '0')}
      </div>
      <button
        className="btn btn-secondary"
        style={{ width: '32px', height: '32px', padding: 0 }}
        onMouseDown={() => startChange(1)} onMouseUp={stopChange} onMouseLeave={stopChange}
        onTouchStart={() => startChange(1)} onTouchEnd={stopChange}
      >+</button>
      <span style={{ fontSize: '0.75rem', color: 'var(--text-dim)', fontWeight: 600 }}>{label}</span>
    </div>
  )
}

function ProgressBar({ percent }: { percent: number }) {
  return (
    <div className="progress-bar">
      <div className="progress-fill" style={{ width: `${percent}%` }} />
    </div>
  )
}

function Spinner({ style }: { style?: React.CSSProperties }) {
  return (
    <svg style={{ width: '20px', height: '20px', animation: 'spin 1s linear infinite', ...style }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" />
    </svg>
  )
}

function FilePills({ fileList, onRemove }: { fileList: File[]; onRemove: (i: number) => void }) {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', marginTop: '1rem' }}>
      {fileList.map((f, i) => (
        <div key={i} style={{ display: 'inline-flex', alignItems: 'center', gap: '8px', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: '100px', padding: '4px 12px', fontSize: '0.75rem' }}>
          <span style={{ maxWidth: '140px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.name}</span>
          <button onClick={() => onRemove(i)} style={{ background: 'none', border: 'none', color: 'var(--error)', cursor: 'pointer', fontWeight: 800 }}>✕</button>
        </div>
      ))}
    </div>
  )
}


function Card({ children, className = '', onClick, style }: { children: React.ReactNode; className?: string; onClick?: () => void; style?: React.CSSProperties }) {
  return (
    <div className={`card ${className}`} onClick={onClick} style={style}>
      {children}
    </div>
  )
}

function Btn({ children, primary, secondary, small, disabled, onClick, style, className = '' }: {
  children: React.ReactNode; primary?: boolean; secondary?: boolean; small?: boolean
  disabled?: boolean; onClick?: () => void; style?: React.CSSProperties; className?: string
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`btn ${primary ? 'btn-primary' : (secondary ? 'btn-secondary' : '')} ${className}`}
      style={{
        padding: small ? '0.5rem 1rem' : undefined,
        fontSize: small ? '0.8rem' : undefined,
        ...style,
      }}
    >
      {children}
    </button>
  )
}

function Icon({ name, size = 20, style }: { name: 'rocket' | 'lock' | 'cloud' | 'shield' | 'zap' | 'file' | 'copy' | 'check' | 'sun' | 'moon' | 'link', size?: number, style?: React.CSSProperties }) {
  const icons = {
    rocket: <path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.71-2.13.09-2.91a2.18 2.18 0 0 0-3.09-.09zm9.24-9.25L10.03 11l-1.42-1.42 3.71-3.71A5.002 5.002 0 0 1 18 5c0 2.21-1.79 4-4 4a5.002 5.002 0 0 1-4.26-2.25zm.76 10.75l1.42 1.42-3.71 3.71A5.002 5.002 0 0 1 6 19c0-2.21 1.79-4 4-4a5.002 5.002 0 0 1 4.26 2.25l3.74-3.75zM14 11l5-5m-1 5l5-5" />,
    lock: <><rect x="3" y="11" width="18" height="11" rx="2" ry="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" /></>,
    cloud: <path d="M17.5 19c2.5 0 4.5-2 4.5-4.5 0-2.2-1.6-4.1-3.7-4.4C17.8 6.6 14.7 4 11 4c-3.3 0-6.1 2.1-7.2 5.1C1.6 9.6 0 11.4 0 13.5 0 15.4 1.6 17 3.5 17h14M9 13l3-3 3 3M12 10v9" />,
    shield: <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />,
    zap: <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />,
    file: <><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" /><polyline points="13 2 13 9 20 9" /></>,
    copy: <><rect x="9" y="9" width="13" height="13" rx="2" ry="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></>,
    check: <polyline points="20 6 9 17 4 12" />,
    sun: <><circle cx="12" cy="12" r="5" /><line x1="12" y1="1" x2="12" y2="3" /><line x1="12" y1="21" x2="12" y2="23" /><line x1="4.22" y1="4.22" x2="5.64" y2="5.64" /><line x1="18.36" y1="18.36" x2="19.78" y2="19.78" /><line x1="1" y1="12" x2="3" y2="12" /><line x1="21" y1="12" x2="23" y2="12" /><line x1="4.22" y1="19.07" x2="5.64" y2="17.66" /><line x1="18.36" y1="5.64" x2="19.78" y2="4.22" /></>,
    moon: <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />,
    link: <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
  }
  return (
    <svg width={size} height={size} style={style} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      {icons[name]}
    </svg>
  )
}
