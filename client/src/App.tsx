import { useState, useRef, useEffect, useCallback } from 'react'
import { QRCodeSVG } from 'qrcode.react'
import { SignalingClient } from './lib/signalingClient'
import { WebRTCManager, type ChannelState } from './lib/webrtc'
import { TransferReceiver, sendTransfer, type TransferProgress, type ReceivedTransfer, type ReceivedFile } from './lib/transfer'
import { encrypt, decrypt, arrayBufferToBase64, base64ToArrayBuffer } from './lib/crypto'
import { guessMime } from './lib/mime'
import type { SignalMessage, PeerRole } from './types'
import { AiChat } from './components/AiChat'
import type { AiSource, AskResult } from './components/AiChat'
import { ToastHost } from './components/Toast'
import { toast } from './components/toastBus'
import { Card, Btn, Badge, Field, TextInput, TextArea, Progress, Spinner, Icon } from './components/ui'

const RAW_API_URL = (import.meta.env.VITE_API_URL as string | undefined)?.trim()
const API_URL = (RAW_API_URL || window.location.origin).replace(/\/$/, '')
const SIGNALING_URL = API_URL.startsWith('https') ? API_URL.replace('https', 'wss') : API_URL.replace('http', 'ws')
const STORED_TTL_MIN = 1 * 60
const STORED_TTL_MAX = 10 * 60 * 60
const STORED_MAX = 10 * 1024 * 1024
const ICE_CACHE_TTL_MS = 25 * 60 * 1000
const LIVE_TTL_MS = 24 * 60 * 60 * 1000
const E2EE_OVERHEAD_BYTES = 16 + 12

function encryptedTextBytes(rawBytes: number): number { return Math.ceil((rawBytes + E2EE_OVERHEAD_BYTES) / 3) * 4 }
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
function getTextBytes(text: string): number { return new TextEncoder().encode(text).length }
function passwordHeaders(password: string): Record<string, string> { return password ? { 'x-session-password': password } : {} }
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
  a.href = url; a.download = filename; a.style.display = 'none'
  document.body.appendChild(a); a.click(); document.body.removeChild(a)
}
async function fetchStoredFileBlob(f: StoredFileInfo, passwordHeader: string): Promise<Blob> {
  const res = await fetch(`${API_URL}/file/${f.fileId}/${f.token}`, { headers: passwordHeader ? { 'x-session-password': passwordHeader } : {} })
  if (!res.ok) throw new Error(String(res.status))
  const raw = await res.blob()
  const type = guessMime(f.name, f.mimeType || raw.type)
  if (!passwordHeader) return raw.type === type ? raw : new Blob([raw], { type })
  const buffer = await raw.arrayBuffer()
  const decrypted = await decrypt(buffer, passwordHeader, false) as ArrayBuffer
  return new Blob([decrypted], { type })
}
async function prefetchStoredFiles(fileList: StoredFileInfo[], pass: string): Promise<{ fileId: string; blob: Blob | null }[]> {
  return Promise.all(fileList.map(async f => {
    try { return { fileId: f.fileId, blob: await fetchStoredFileBlob(f, pass) } } catch { return { fileId: f.fileId, blob: null } }
  }))
}
async function previewBlobInNewTab(getBlob: () => Promise<Blob>, fallbackName: string, urlSuffix = '') {
  const win = window.open('about:blank', '_blank')
  if (win) win.opener = null
  try {
    const blob = await getBlob()
    const url = URL.createObjectURL(blob)
    // Security: For HTML/SVG files, use a sandboxed iframe to prevent XSS
    const ext = fallbackName.split('.').pop()?.toLowerCase() || ''
    const isDangerous = ['html', 'htm', 'svg', 'xhtml'].includes(ext)
    if (isDangerous && win && !win.closed) {
      // Write a sandboxed iframe that can't execute scripts
      win.document.write(`<!DOCTYPE html><html><head><title>${fallbackName.replace(/</g, '&lt;')}</title></head><body style="margin:0"><iframe src="${url}" sandbox="allow-same-origin" style="width:100vw;height:100vh;border:none"></iframe></body></html>`)
      win.document.close()
    } else if (ext === 'js' && win && !win.closed) {
      // For JS files, show the source code instead of executing it
      const text = await blob.text()
      const escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      win.document.write(`<!DOCTYPE html><html><head><title>${fallbackName.replace(/</g, '&lt;')}</title><style>body{font-family:monospace;padding:1rem;background:#1a1a1a;color:#d4d4d4;white-space:pre-wrap;overflow:auto}</style></head><body>${escaped}</body></html>`)
      win.document.close()
    } else if (win && !win.closed) {
      win.location.href = url + urlSuffix
    } else {
      anchorDownload(url, fallbackName)
    }
    setTimeout(() => URL.revokeObjectURL(url), 60000)
  } catch (err) { win?.close(); throw err }
}

type PublishMode = 'stored' | 'live'
interface StoredFileInfo { name: string; mimeType: string; size: number; fileId: string; token: string }
interface RetrievedPayload { mode: 'stored'; text: string; expiresAt: number; burnOnRead?: boolean; burnGraceMs?: number; files: StoredFileInfo[] }
interface RecipientConn { peerId: string; rtc: WebRTCManager; channelState: ChannelState; sendProgress: TransferProgress | null; lastSentAt: number | null }

export default function App() {
  const [view, setView] = useState<'home' | 'publish' | 'join'>('home')
  const [code, setCode] = useState('')
  const [joinToken, setJoinToken] = useState('')
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
  const [isPrivate, setIsPrivate] = useState(false)
  const [inputPassword, setInputPassword] = useState('')
  const [burnOnRead, setBurnOnRead] = useState(false)
  const [isStorageFull, setIsStorageFull] = useState(false)
  const [aiStatus, setAiStatus] = useState<'none' | 'pending' | 'ready' | 'failed'>('none')
  const [theme, setTheme] = useState<'dark' | 'light'>(() => localStorage.getItem('qs_theme') === 'light' ? 'light' : 'dark')
  const [dragOver, setDragOver] = useState(false)

  const sigRef = useRef<SignalingClient | null>(null)
  const rtcMapRef = useRef<Map<string, WebRTCManager>>(new Map())
  const rtcRef = useRef<WebRTCManager | null>(null)
  const receiverRef = useRef<TransferReceiver | null>(null)
  const recipientCountRef = useRef(0)
  const p2pEverLiveRef = useRef(false)
  const iceServersRef = useRef<RTCIceServer[]>([])
  const iceFetchedAtRef = useRef(0)
  const prefetchedRef = useRef<Map<string, Blob>>(new Map())
  const sessionGenRef = useRef(0)
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const linkTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const passwordTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (!expiresAt) { setCountdown(''); return }
    const tick = () => setCountdown(formatCountdown(expiresAt - Date.now()))
    tick(); const id = setInterval(tick, 1000); return () => clearInterval(id)
  }, [expiresAt])
  useEffect(() => { document.documentElement.setAttribute('data-theme', theme); localStorage.setItem('qs_theme', theme) }, [theme])
  useEffect(() => {
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      if (publishedMode === 'live' && sigState === 'connected') { e.preventDefault(); e.returnValue = '' }
    }
    window.addEventListener('beforeunload', handleBeforeUnload)
    return () => window.removeEventListener('beforeunload', handleBeforeUnload)
  }, [publishedMode, sigState])
  useEffect(() => {
    const path = window.location.pathname.replace(/^\//, '').trim()
    const params = new URLSearchParams(window.location.search)
    const k = params.get('k') || ''
    if (/^\d{6}$/.test(path)) { setInputCode(path); if (k) setJoinToken(k); window.history.replaceState(null, '', '/') }
  }, [])
  useEffect(() => {
    const checkStatus = async () => {
      try {
        const r = await fetch(`${API_URL}/health`)
        const data = await r.json()
        if (typeof data.storedModeEnabled === 'boolean') setStoredEnabled(data.storedModeEnabled)
        if (typeof data.isStorageFull === 'boolean') setIsStorageFull(data.isStorageFull)
      } catch { setStoredEnabled(true) }
    }
    checkStatus()
  }, [])

  const totalBytes = files.reduce((s, f) => s + f.size, 0)
  const willEncryptStored = (publishedMode === 'stored' || !publishedMode) && isPrivate && password.length > 0
  const textBytes = willEncryptStored ? encryptedTextBytes(getTextBytes(text)) : getTextBytes(text)
  const payloadBytes = totalBytes + textBytes
  const mode: PublishMode =
    publishedMode === 'stored' ? 'stored' :
      publishedMode === 'live' ? 'live' :
        (!storedEnabled) ? 'live' :
          (payloadBytes <= STORED_MAX) ? 'stored' : 'live'
  const hasPayload = text.trim().length > 0 || files.length > 0

  function copyCode() {
    if (!code) return
    navigator.clipboard.writeText(code).catch(() => {
      const el = document.createElement('textarea'); el.value = code; document.body.appendChild(el); el.select(); document.execCommand('copy'); document.body.removeChild(el)
    })
    setCopiedCode(true); if (copyTimerRef.current) clearTimeout(copyTimerRef.current)
    copyTimerRef.current = setTimeout(() => setCopiedCode(false), 2000)
  }
  function copyLink() {
    if (!code) return
    const url = joinToken ? `${window.location.origin}/${code}?k=${joinToken}` : `${window.location.origin}/${code}`
    navigator.clipboard.writeText(url).catch(() => {
      const el = document.createElement('textarea'); el.value = url; document.body.appendChild(el); el.select(); document.execCommand('copy'); document.body.removeChild(el)
    })
    setCopiedLink(true); if (linkTimerRef.current) clearTimeout(linkTimerRef.current)
    linkTimerRef.current = setTimeout(() => setCopiedLink(false), 2000)
  }
  function copyPassword() {
    if (!password) return
    navigator.clipboard.writeText(password).catch(() => {
      const el = document.createElement('textarea'); el.value = password; document.body.appendChild(el); el.select(); document.execCommand('copy'); document.body.removeChild(el)
    })
    setCopiedPassword(true); if (passwordTimerRef.current) clearTimeout(passwordTimerRef.current)
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
  function handleDrop(e: React.DragEvent) {
    e.preventDefault(); setDragOver(false)
    const dropped = Array.from(e.dataTransfer.files)
    if (dropped.length) {
      setFiles(prev => {
        const existing = new Set(prev.map(f => `${f.name}:${f.size}`))
        return [...prev, ...dropped.filter(f => !existing.has(`${f.name}:${f.size}`))]
      })
    }
  }
  function clampStoredTtl(seconds: number): number { return Math.min(Math.max(seconds, STORED_TTL_MIN), STORED_TTL_MAX) }
  function setStoredDuration(hoursValue: number, minutesValue: number) {
    const hours = Number.isFinite(hoursValue) ? Math.max(0, Math.min(10, Math.trunc(hoursValue))) : 0
    const minutes = Number.isFinite(minutesValue) ? Math.max(0, Math.min(59, Math.trunc(minutesValue))) : 0
    const totalSeconds = (hours * 3600) + (minutes * 60)
    setTtlSeconds(clampStoredTtl(totalSeconds))
  }

  async function handleStoredPublish() {
    if (!hasPayload) return
    if (!storedEnabled) { setPublishError('Stored mode requires MongoDB. Set MONGODB_URI and restart the server.'); return }
    setPublishing(true); setPublishError('')
    const isUpdate = publishedMode === 'stored' && code !== ''
    const privatePassword = isPrivate && publishedMode !== 'live' ? password.trim() : ''
    if (isPrivate && !privatePassword) return
    try {
      const form = new FormData()
      let finalText = text
      if (privatePassword) {
        const encryptedText = await encrypt(text, privatePassword)
        finalText = arrayBufferToBase64(encryptedText)
      }
      form.append('text', finalText)
      form.append('ttlMs', String(clampStoredTtl(ttlSeconds) * 1000))
      if (privatePassword) form.append('password', privatePassword)
      form.append('burnOnRead', String(burnOnRead))
      for (const f of files) {
        if (privatePassword) {
          const buffer = await f.arrayBuffer()
          const encrypted = await encrypt(buffer, privatePassword)
          form.append('files', new Blob([encrypted], { type: f.type || 'application/octet-stream' }), f.name)
        } else form.append('files', f)
      }
      const url = isUpdate ? `${API_URL}/publish/${code}` : `${API_URL}/publish`
      const method = isUpdate ? 'PATCH' : 'POST'
      const data = await new Promise<{ code: string; joinToken?: string; expiresAt: number; mode: string; error?: string }>((resolve, reject) => {
        const xhr = new XMLHttpRequest()
        xhr.open(method, url); xhr.timeout = 5 * 60 * 1000
        if (privatePassword) xhr.setRequestHeader('x-session-password', privatePassword)
        xhr.onload = () => {
          try {
            const resp = JSON.parse(xhr.responseText)
            if (xhr.status >= 400) resolve({ error: resp.error || 'Request failed', ...resp })
            else resolve(resp)
          } catch { reject(new Error('Invalid response from server')) }
        }
        xhr.onerror = () => reject(new Error('Network error. The server might be offline or unreachable.'))
        xhr.ontimeout = () => reject(new Error('Upload timed out. Please try a smaller file or a faster connection.'))
        xhr.send(form)
      })
      if (data.error) {
        setPublishError(data.error.includes('not found') ? 'Session not found.' : data.error)
        if (data.error.includes('not found') && isUpdate) { setCode(''); setPublishedMode(null) }
        setPublishing(false); return
      }
      setCode(data.code); setJoinToken(data.joinToken || ''); setExpiresAt(data.expiresAt); setPublishedMode('stored')
    } catch (err: unknown) { setPublishError(err instanceof Error ? err.message : 'An unexpected error occurred.') }
    setPublishing(false)
  }

  async function handleLivePublish() {
    setPublishing(true); setPublishError('')
    await fetchIceServers()
    try {
      const res = await fetch(`${API_URL}/session`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ttlMs: LIVE_TTL_MS, password }) })
      const data = await res.json()
      if (!res.ok) { setPublishError(data.error || 'Could not complete publish.'); setPublishing(false); return }
      setCode(data.code); setPublishedMode('live'); setExpiresAt(data.expiresAt); startSignaling(data.code, 'publisher')
    } catch { setPublishError('Could not connect to server. Please try again.') }
    setPublishing(false)
  }

  async function handleSendTo(peerId: string, providedRtc?: WebRTCManager) {
    if (!hasPayload) return
    const rtc = providedRtc || rtcMapRef.current.get(peerId)
    if (!rtc || rtc.getDataChannel()?.readyState !== 'open') return
    setRecipients(prev => prev.map(x => x.peerId === peerId ? { ...x, sendProgress: null } : x))
    try {
      await sendTransfer(rtc, text, files, p => { setRecipients(prev => prev.map(x => x.peerId === peerId ? { ...x, sendProgress: p } : x)) })
      setRecipients(prev => prev.map(x => x.peerId === peerId ? { ...x, lastSentAt: Date.now(), sendProgress: null } : x))
    } catch { toast('Connection issue. Please try again.', 'error') }
  }

  async function handleJoin() {
    if (inputCode.length !== 6) return
    setJoining(true); setJoinError('')
    try {
      const joinParam = joinToken ? `?k=${joinToken}` : ''
      const res = await fetch(`${API_URL}/retrieve/${inputCode}${joinParam}`, { headers: passwordHeaders(inputPassword) })
      if (res.ok) {
        const data: RetrievedPayload = await res.json()
        if (inputPassword && data.text) {
          try { data.text = await decrypt(base64ToArrayBuffer(data.text), inputPassword, true) as string }
          catch { setJoinError('Unable to decrypt the message. Check the password.'); setJoining(false); return }
        }
        setStoredPayload(data); setCode(inputCode); setExpiresAt(data.expiresAt); setView('join')
        const aiJoinParam = joinToken ? `?k=${joinToken}` : ''
        void fetch(`${API_URL}/ai/status/${inputCode}${aiJoinParam}`).then(r => r.json()).then(st => {
          if (typeof st.aiStatus === 'string') setAiStatus(st.aiStatus as 'none' | 'pending' | 'ready' | 'failed')
        }).catch(() => {})
        if (data.burnOnRead && data.files.length > 0) {
          const gen = sessionGenRef.current
          void prefetchStoredFiles(data.files, inputPassword).then(results => {
            if (sessionGenRef.current !== gen) return
            for (const r of results) if (r.blob) prefetchedRef.current.set(r.fileId, r.blob)
            if (results.some(r => !r.blob)) setJoinError('Some files could not be preloaded before the session self-destructed.')
          })
        }
        setJoining(false); return
      }
      if (res.status === 401) { setJoinError('Invalid password. Please try again.'); setJoining(false); return }
      if (res.status === 410) { setJoinError('This session has expired.'); setJoining(false); return }
      if (res.status === 404) {
        const data = await res.json()
        if (data.error === 'live_session') { setCode(inputCode); setView('join'); startSignaling(inputCode, 'recipient'); setJoining(false); return }
        setJoinError('Session not found. Check the code.'); setJoining(false); return
      }
      const data = await res.json().catch(() => ({} as Record<string, unknown>))
      setJoinError((data as { error?: string }).error || 'Could not join session.')
    } catch { setJoinError('Server not connected.') }
    setJoining(false)
  }

  async function handleStoredDownload(f: StoredFileInfo) {
    try {
      let finalBlob = prefetchedRef.current.get(f.fileId)
      if (!finalBlob) finalBlob = await fetchStoredFileBlob(f, inputPassword)
      const u = URL.createObjectURL(finalBlob)
      anchorDownload(u, f.name); setTimeout(() => URL.revokeObjectURL(u), 1000)
    } catch { toast('Failed to download file. Check password or connection.', 'error') }
  }
  async function handleStoredPreview(f: StoredFileInfo, page?: number | null) {
    try {
      const suffix = page != null && /pdf/i.test(f.mimeType) ? `#page=${page}` : ''
      await previewBlobInNewTab(async () => {
        const cached = prefetchedRef.current.get(f.fileId)
        return cached ?? fetchStoredFileBlob(f, inputPassword)
      }, f.name, suffix)
    } catch { toast('Unable to open the file. Check password or connection.', 'error') }
  }
  function handleLiveDownload(f: ReceivedFile) {
    const url = URL.createObjectURL(f.blob)
    anchorDownload(url, f.name); setTimeout(() => URL.revokeObjectURL(url), 10000)
  }
  function handleLivePreview(f: ReceivedFile) {
    void previewBlobInNewTab(() => Promise.resolve(f.blob), f.name).catch(() => { toast('Unable to open the file.', 'error') })
  }

  const fetchIceServers = useCallback(async (): Promise<RTCIceServer[]> => {
    const fresh = Date.now() - iceFetchedAtRef.current < ICE_CACHE_TTL_MS
    if (iceServersRef.current.length > 0 && fresh) return iceServersRef.current
    try {
      const res = await fetch(`${API_URL}/ice-servers`)
      if (!res.ok) throw new Error()
      const data = await res.json() as { iceServers: RTCIceServer[] }
      iceServersRef.current = data.iceServers; iceFetchedAtRef.current = Date.now(); return data.iceServers
    } catch {
      return iceServersRef.current.length > 0 ? iceServersRef.current : [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' }]
    }
  }, [])

  function startSignaling(sessionCode: string, sessionRole: PeerRole) {
    const sig = new SignalingClient({
      serverUrl: SIGNALING_URL, code: sessionCode, role: sessionRole, password: sessionRole === 'recipient' ? inputPassword : password,
      onOpen: () => setSigState('connected'), onClose: () => setSigState('disconnected'), onError: () => { },
      onMessage: msg => handleSignalingMessage(msg, sessionRole, sig),
      onReconnecting: (attempt, max) => {
        if (p2pEverLiveRef.current) { sigRef.current?.disconnect(); setSigState('offline'); return }
        setSigState(`reconnecting ${attempt}/${max}`)
      },
      onReconnectFailed: () => setSigState(p2pEverLiveRef.current ? 'offline' : 'failed'),
    })
    sigRef.current = sig; sig.connect()
  }

  async function handleSignalingMessage(msg: SignalMessage, sessionRole: PeerRole, sig: SignalingClient) {
    if (msg.type === 'error') {
      if (typeof msg.payload === 'string' && msg.payload === 'invalid_password') {
        setJoinError('Invalid session password.'); sig.disconnect(); setSigState('disconnected'); setView('home'); return
      }
      if (typeof msg.payload === 'string' && msg.payload.startsWith('Waiting for publisher')) return
      if (typeof msg.payload === 'string' && msg.payload.startsWith('Session not found')) {
        if (p2pEverLiveRef.current) { sigRef.current?.disconnect(); setSigState('offline') }
        else { setJoinError('Session not found or expired.'); setSigState('lost'); setView('home') }
        return
      }
      return
    }
    if (msg.type === 'expired') { setSigState('expired'); return }
    if (msg.type === 'peer_left') {
      if (sessionRole === 'publisher' && msg.peerId) {
        rtcMapRef.current.get(msg.peerId)?.close(); rtcMapRef.current.delete(msg.peerId)
        setRecipients(prev => prev.filter(r => r.peerId !== msg.peerId))
      } else setChannelState('closed')
      return
    }
    if (msg.type === 'ready') {
      const peerId = msg.peerId; if (!peerId) return
      if (sessionRole === 'publisher') {
        recipientCountRef.current += 1
        const rtc = new WebRTCManager({
          role: 'publisher', peerId, signalingClient: sig,
          iceServers: iceServersRef.current.length > 0 ? iceServersRef.current : undefined,
          onChannelStateChange: state => {
            if (state === 'open') { p2pEverLiveRef.current = true; handleSendTo(peerId, rtc) }
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
        const receiver = new TransferReceiver(p => setRecvProgress(p), result => { setReceived(result); setRecvProgress(null) }, reason => { setJoinError(reason); setRecvProgress(null) })
        receiverRef.current = receiver
        const rtc = new WebRTCManager({
          role: 'recipient', peerId, signalingClient: sig,
          iceServers: iceServersRef.current.length > 0 ? iceServersRef.current : undefined,
          onChannelStateChange: state => {
            if (state === 'open') p2pEverLiveRef.current = true
            setChannelState(state)
            if ((state === 'closed' || state === 'error') && receiverRef.current) { receiverRef.current.abort('Publisher disconnected mid-transfer'); receiverRef.current = null }
          },
          onChannelMessage: data => receiver.receive(data),
        })
        rtcRef.current = rtc; await rtc.start()
      }
      return
    }
    if (sessionRole === 'publisher') {
      const rtc = msg.peerId ? rtcMapRef.current.get(msg.peerId) : null
      if (rtc) await rtc.handleSignal(msg)
    } else if (rtcRef.current) await rtcRef.current.handleSignal(msg)
  }

  async function askAiOnce(question: string, cbs?: { onDelta?: (t: string) => void; onSources?: (s: AiSource[]) => void; onDone?: (fullText: string, refused: boolean, cached: boolean) => void }): Promise<AskResult> {
    try {
      const aiJoinParam = joinToken ? `?k=${joinToken}` : ''
      const res = await fetch(`${API_URL}/ai/query/${code}${aiJoinParam}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', ...passwordHeaders(inputPassword) },
        body: JSON.stringify({ question }), signal: AbortSignal.timeout(90_000),
      })
      const ct = res.headers.get('content-type') ?? ''
      if (!res.ok) { const data = await res.json(); return { answer: '', error: String(data.error ?? 'ai_error'), status: res.status } }
      if (ct.includes('text/event-stream')) {
        const reader = res.body!.getReader(); const decoder = new TextDecoder()
        let buf = ''; let full = ''; let refused = false; let cached = false; let err: string | null = null; let groqStatus: number | undefined; let sources: AiSource[] | undefined
        while (true) {
          const { done, value } = await reader.read(); if (done) break
          buf += decoder.decode(value, { stream: true })
          let nl: number
          while ((nl = buf.indexOf('\n\n')) !== -1) {
            const frame = buf.slice(0, nl); buf = buf.slice(nl + 2)
            const evLine = frame.split('\n').find(l => l.startsWith('event:'))
            const dataLine = frame.split('\n').find(l => l.startsWith('data:'))
            if (!dataLine) continue
            const ev = evLine?.slice(6).trim() ?? 'message'
            const payload = JSON.parse(dataLine.slice(5).trim())
            if (ev === 'sources') { sources = payload.sources; cbs?.onSources?.(sources ?? []) }
            else if (ev === 'delta') { full += payload.t; cbs?.onDelta?.(payload.t) }
            else if (ev === 'done') { refused = !!payload.refused; cached = !!payload.cached; full = payload.fullText ?? full; cbs?.onDone?.(full, refused, cached) }
            else if (ev === 'error') { err = String(payload.error); groqStatus = payload.groqStatus }
          }
        }
        if (err) return { answer: '', error: err, groqStatus }
        return { answer: full, refused, sources, status: res.status }
      }
      const data = await res.json()
      if (!res.ok) return { answer: '', error: String(data.error ?? 'ai_error'), status: res.status }
      return { answer: data.answer, refused: data.refused, sources: data.sources }
    } catch { return { answer: '', error: 'network' } }
  }
  async function askAi(question: string, cbs?: { onDelta?: (t: string) => void; onSources?: (s: AiSource[]) => void; onDone?: (fullText: string, refused: boolean, cached: boolean) => void }): Promise<AskResult> {
    let r = await askAiOnce(question, cbs)
    if ((r.error === 'network' || (r.status !== undefined && r.status >= 500)) && !cbs?.onDelta) { await new Promise(res => setTimeout(res, 900)); r = await askAiOnce(question, cbs) }
    return { answer: r.answer, refused: r.refused, sources: r.sources, error: r.error }
  }

  function reset() {
    sessionGenRef.current++
    rtcMapRef.current.forEach(r => r.close()); rtcMapRef.current.clear()
    rtcRef.current?.close(); rtcRef.current = null
    sigRef.current?.disconnect(); sigRef.current = null
    receiverRef.current = null; recipientCountRef.current = 0; p2pEverLiveRef.current = false
    iceServersRef.current = []; iceFetchedAtRef.current = 0; prefetchedRef.current.clear()
    if (copyTimerRef.current) clearTimeout(copyTimerRef.current)
    if (linkTimerRef.current) clearTimeout(linkTimerRef.current)
    if (passwordTimerRef.current) clearTimeout(passwordTimerRef.current)
    setView('home'); setCode(''); setInputCode(''); setText(''); setFiles([]); setTtlSeconds(3600)
    setPublishing(false); setPublishedMode(null); setExpiresAt(null); setCopiedCode(false); setCopiedLink(false); setCopiedPassword(false)
    setSigState('disconnected'); setRecipients([]); setChannelState('idle'); setRecvProgress(null); setReceived(null); setStoredPayload(null)
    setJoining(false); setJoinError(''); setCountdown(''); setPassword(''); setInputPassword(''); setIsPrivate(false); setAiStatus('none'); setBurnOnRead(false); setShowPassword(false)
  }
  function sigColor() {
    if (['failed', 'lost', 'expired'].includes(sigState)) return 'var(--error)'
    if (sigState.startsWith('reconnecting') || sigState === 'offline') return 'var(--warning)'
    if (sigState === 'connected') return 'var(--success)'
    return 'var(--text-3)'
  }
  function sigLabel() {
    if (sigState === 'connected') return 'Connected'
    if (sigState === 'disconnected') return 'Disconnected'
    if (sigState === 'lost') return 'Session Lost'
    if (sigState === 'offline') return 'Offline'
    if (sigState === 'expired') return 'Expired'
    if (sigState.startsWith('reconnecting')) return 'Reconnecting…'
    return sigState
  }
  function channelLabel(state: ChannelState) {
    if (state === 'open') return 'Live'
    if (state === 'connecting') return 'Connecting…'
    if (state === 'idle') return sigState === 'connected' ? 'Waiting for sender…' : 'Waiting…'
    if (state === 'error') return 'Error'
    return state
  }
  const qrUrl = joinToken ? `${window.location.origin}/${code}?k=${joinToken}` : `${window.location.origin}/${code}`

  return (
    <div className="app-shell">
      <ToastHost />
      <header className="site-header">
        <div className="container site-header__inner">
          <a className="brand" href="#" onClick={e => { e.preventDefault(); if (publishedMode || view !== 'home') reset(); else setView('home') }}>
            <span className="brand__mark"><Icon name="zap" size={16} /></span>
            <span className="brand__name">QuickShare</span>
            <span className="brand__sub">P2P · Cloud · AI</span>
          </a>
          <div className="header-actions">
            {(publishedMode || code) && (
              <Btn size="sm" onClick={reset}><Icon name="upload" size={14} /> New session</Btn>
            )}
            {view !== 'publish' && !publishedMode && (
              <Btn variant="primary" size="sm" onClick={() => setView('publish')} style={{ display: view === 'home' ? 'inline-flex' : 'none' }}>
                <Icon name="upload" size={14} /> Share
              </Btn>
            )}
            <button className="btn btn--icon" aria-label="Toggle theme" onClick={() => setTheme(t => t === 'dark' ? 'light' : 'dark')}>
              <Icon name={theme === 'dark' ? 'sun' : 'moon'} size={16} />
            </button>
          </div>
        </div>
      </header>

      <main className="container" style={{ paddingTop: 20, paddingBottom: 24 }}>
        {/* Home */}
        {view === 'home' && !publishedMode && (
          <div className="animate-fade" style={{ display: 'grid', gap: 18 }}>
            <div className="hero">
              <h1>Share anything, <span>instantly</span></h1>
              <p>End-to-end encrypted cloud drops for up to 10 MB · Unlimited peer-to-peer for anything larger · Ask AI about your files.</p>
              
            </div>

            <div className="grid-2">
              <Card>
                <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
                  <div>
                    <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8, color: 'var(--accent)' }}><Icon name="zap" size={18} /><span style={{ fontWeight: 800, fontSize: '0.95rem' }}>Create a session</span></div>
                    <p style={{ color: 'var(--text-2)', fontSize: '0.86rem', marginTop: 6, lineHeight: 1.5 }}>Paste text, drop files, pick privacy, and get a 6-digit code to share.</p>
                  </div>
                  <Badge tone="accent">New</Badge>
                </div>
                <div className="cluster" style={{ marginTop: 16 }}>
                  <Btn variant="primary" size="lg" block onClick={() => setView('publish')}><Icon name="upload" size={16} /> Start sharing</Btn>
                </div>
                <div style={{ display: 'flex', gap: 16, marginTop: 14, flexWrap: 'wrap' }}>
                  <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center', fontSize: '0.78rem', color: 'var(--text-2)' }}><Icon name="sparkles" size={12} /> AI Q&A</span>
                  <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center', fontSize: '0.78rem', color: 'var(--text-2)' }}><Icon name="cloud" size={12} /> Burn-on-read</span>
                </div>
              </Card>

              <Card>
                <div className="card__head" style={{ marginBottom: 12 }}>
                  <span className="card__title">Join session</span>
                  <Badge tone={inputCode.length === 6 ? 'success' : 'default'}>6-digit code</Badge>
                </div>
                <div className="stack stack--sm">
                  <div style={{ display: 'flex', gap: 10 }}>
                    <input
                      className="input input--mono"
                      inputMode="numeric"
                      autoComplete="one-time-code"
                      placeholder="000000"
                      value={inputCode}
                      onChange={e => { setInputCode(e.target.value.replace(/\D/g, '').slice(0, 6)); if (joinError) setJoinError('') }}
                      onKeyDown={e => e.key === 'Enter' && handleJoin()}
                      style={{ flex: 1, textAlign: 'center', letterSpacing: '0.18em', fontWeight: 800, fontSize: '1.15rem' }}
                      aria-label="Session code"
                    />
                    <Btn variant="primary" onClick={handleJoin} disabled={inputCode.length !== 6 || joining} style={{ minWidth: 92 }}>
                      {joining ? <Spinner size={16} /> : 'Join'}
                    </Btn>
                  </div>
                  <TextInput
                    type="password"
                    placeholder="Password — only for private sessions"
                    value={inputPassword}
                    onChange={e => { setInputPassword(e.target.value); if (joinError) setJoinError('') }}
                    onKeyDown={e => e.key === 'Enter' && handleJoin()}
                    icon={<Icon name="lock" size={14} />}
                    aria-label="Session password"
                  />
                  {joinError && <div className="callout" style={{ borderColor: 'var(--error)', background: 'var(--error-soft)', color: 'var(--error)' }}><Icon name="alert" size={14} /> <span style={{ fontWeight: 650 }}>{joinError}</span></div>}
                </div>
              </Card>
            </div>

            <Card pad={false} style={{ padding: 16, display: 'flex', gap: 14, alignItems: 'center', flexWrap: 'wrap', justifyContent: 'space-between' }}>
              <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                <span style={{ width: 28, height: 28, borderRadius: 999, display: 'grid', placeItems: 'center', background: 'var(--surface-2)', border: '1px solid var(--border)', color: 'var(--text-2)' }}><Icon name="clock" size={14} /></span>
                <div>
                  <div style={{ fontWeight: 750, fontSize: '0.88rem' }}>How it works</div>
                  <div style={{ color: 'var(--text-2)', fontSize: '0.82rem' }}>≤10 MB → encrypted cloud + AI · &gt;10 MB → direct P2P · No backend ever sees P2P content.</div>
                </div>
              </div>
              <div className="cluster">
                <Badge tone="accent">≤10 MB cloud</Badge>
                <Badge>Unlimited P2P</Badge>
              </div>
            </Card>
          </div>
        )}

        {/* Publish */}
        {view === 'publish' && !publishedMode && (
          <div className="animate-fade stack">
            <div className="cluster" style={{ justifyContent: 'space-between' }}>
              <Btn size="sm" onClick={() => setView('home')}>← Back</Btn>
              <div className="cluster" style={{ color: 'var(--text-2)', fontSize: '0.84rem', fontWeight: 650 }}><Icon name="cloud" size={14} /> Create session</div>
            </div>

            <Card>
              <Field label="Message" hint="Links, notes, markdown — optional if you’re sending files.">
                <TextArea placeholder="Paste links, text snippets, or markdown…" value={text} onChange={e => setText(e.target.value)} rows={4} />
              </Field>
              <div style={{ height: 14 }} />
              <Field label="Files">
                <div
                  className={`dropzone ${dragOver ? 'dropzone--drag' : ''}`}
                  onDragOver={e => { e.preventDefault(); setDragOver(true) }}
                  onDragLeave={() => setDragOver(false)}
                  onDrop={handleDrop}
                >
                  <input type="file" multiple onChange={handleFileChange} aria-label="Choose files" />
                  <div className="dropzone__icon"><Icon name="upload" size={18} /></div>
                  <div className="dropzone__title">{dragOver ? 'Drop to add' : 'Drop files here or click to browse'}</div>
                  <div className="dropzone__sub">Any type · up to 100 MB each · {files.length} selected · {formatBytes(totalBytes)} total</div>
                </div>
                {files.length > 0 && (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 12 }}>
                    {files.map((f, i) => (
                      <span key={`${f.name}-${f.size}-${i}`} className="pill">
                        <Icon name="file" size={12} />
                        <span className="pill__name">{f.name}</span>
                        <span className="pill__size">{formatBytes(f.size)}</span>
                        <button className="pill__rm" onClick={() => setFiles(prev => prev.filter((_, j) => j !== i))} aria-label={`Remove ${f.name}`}>✕</button>
                      </span>
                    ))}
                  </div>
                )}
              </Field>
            </Card>

            <Card>
              <div className="card__head">
                <span className="card__title">Privacy</span>
                <Badge tone={mode === 'stored' ? 'accent' : 'live'}>{mode === 'stored' ? 'Cloud' : 'Live P2P'}</Badge>
              </div>

              {mode === 'stored' ? (
                <div className="stack stack--sm">
                  <div className="segmented" role="tablist" aria-label="Privacy">
                    <button className={`segmented__btn ${!isPrivate ? 'segmented__btn--active segmented__btn--accent' : ''}`} onClick={() => { setIsPrivate(false); setPassword('') }} role="tab" aria-selected={!isPrivate}>
                      <Icon name="cloud" size={14} /> Open · AI-enabled
                    </button>
                    <button className={`segmented__btn ${isPrivate ? 'segmented__btn--active segmented__btn--accent' : ''}`} onClick={() => setIsPrivate(true)} role="tab" aria-selected={isPrivate}>
                      <Icon name="lock" size={14} /> Private · E2EE
                    </button>
                  </div>
                  {!isPrivate ? (
                    <div className="callout callout--info"><Icon name="sparkles" size={16} /> <span>Anyone with the code can read this session. Content is indexed for AI questions with citations.</span></div>
                  ) : (
                    <>
                      <div className="callout"><Icon name="shield" size={16} /> <span>Encrypted locally with AES-256-GCM. Server stores ciphertext only — AI stays off.</span></div>
                      <TextInput type="password" placeholder="Set a strong private password" value={password} onChange={e => setPassword(e.target.value)} icon={<Icon name="lock" size={14} />} />
                    </>
                  )}
                  <label className={`toggle ${burnOnRead ? 'toggle--on' : ''}`} onClick={() => setBurnOnRead(v => !v)}>
                    <span className="toggle__track"><span className="toggle__thumb" /></span>
                    <span className="toggle__label">Burn after first retrieval</span>
                    <Badge>One-time</Badge>
                  </label>
                </div>
              ) : (
                <div className="stack stack--sm">
                  <div className="callout"><Icon name="zap" size={16} /> <span>Live P2P requires a password to protect signaling. Keep this tab open — transfer is direct between browsers.</span></div>
                  <TextInput type="password" placeholder="Set session password (required)" value={password} onChange={e => setPassword(e.target.value)} icon={<Icon name="lock" size={14} />} />
                </div>
              )}

              <div style={{ height: 14 }} />
              <div className="callout" style={{ alignItems: 'center' }}>
                <span style={{ width: 32, height: 32, borderRadius: 10, display: 'grid', placeItems: 'center', background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--accent)', flexShrink: 0 }}><Icon name={mode === 'stored' ? 'cloud' : 'zap'} size={16} /></span>
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 800, fontSize: '0.88rem' }}>{mode === 'stored' ? 'Cloud storage' : 'Live P2P transfer'}</div>
                  <div style={{ color: 'var(--text-2)', fontSize: '0.82rem', lineHeight: 1.5 }}>{mode === 'stored' ? 'Stored on the server until expiry. Best for ≤10 MB.' : 'Device-to-device via WebRTC. No size cap.'}</div>
                </div>
                <Badge>{mode === 'stored' ? `${formatBytes(payloadBytes)} / ${formatBytes(STORED_MAX)}` : `${formatBytes(payloadBytes)}`}</Badge>
              </div>
              {!storedEnabled && !publishedMode && !isStorageFull && (
                <div className="callout callout--warn" style={{ marginTop: 12 }}><Icon name="alert" size={14} /> Cloud storage is currently unavailable — falling back to Live P2P.</div>
              )}
              {isStorageFull && !publishedMode && (
                <div className="callout callout--warn" style={{ marginTop: 12 }}><Icon name="alert" size={14} /> Cloud storage temporarily unavailable — please use Live P2P.</div>
              )}
              {mode === 'stored' && <div style={{ marginTop: 14 }}><DurationPicker ttlSeconds={ttlSeconds} setStoredDuration={setStoredDuration} /></div>}
            </Card>

            <Btn
              variant="primary"
              size="lg"
              block
              onClick={() => mode === 'stored' ? handleStoredPublish() : handleLivePublish()}
              disabled={!hasPayload || publishing || (mode === 'live' && !password) || (mode === 'stored' && isPrivate && !password)}
            >
              {publishing ? <><Spinner size={16} /> Publishing…</> : <><Icon name="zap" size={16} /> Launch session · {formatTTL(ttlSeconds)}</>}
            </Btn>
            {publishError && <div className="callout" style={{ borderColor: 'var(--error)', background: 'var(--error-soft)', color: 'var(--error)' }}><Icon name="alert" size={14} /> {publishError}</div>}
          </div>
        )}

        {/* Published */}
        {(publishedMode === 'stored' || publishedMode === 'live') && (
          <div className="animate-fade stack">
            <Card style={{ textAlign: 'center' }}>
              <div className="cluster" style={{ justifyContent: 'center' }}>
                <Badge tone="success" dot>Session live</Badge>
                <Badge>{publishedMode === 'stored' ? 'Cloud' : 'Live P2P'}</Badge>
                {countdown && <Badge tone="accent"><Icon name="clock" size={12} /> {countdown}</Badge>}
              </div>
              <div className="code-display">{code}</div>
              <div style={{ color: 'var(--text-2)', fontSize: '0.84rem', marginTop: 2, fontFamily: 'var(--font-mono)' }}>{qrUrl}</div>

              {(password || (publishedMode === 'stored' && isPrivate)) && (
                <div style={{ marginTop: 16, textAlign: 'left', padding: 12, borderRadius: 'var(--radius)', background: 'var(--surface-2)', border: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: '0.7rem', fontWeight: 800, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--text-2)' }}>Password</div>
                    <div style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginTop: 2 }}>{showPassword ? (password || '••••') : '••••••••'}</div>
                  </div>
                  <div className="cluster">
                    <Btn size="sm" onClick={() => setShowPassword(v => !v)}>{showPassword ? <><Icon name="eye" size={12} /> Hide</> : <><Icon name="eye" size={12} /> Show</>}</Btn>
                    <Btn size="sm" variant="primary" onClick={copyPassword}>{copiedPassword ? <><Icon name="check" size={12} /> Copied</> : <><Icon name="copy" size={12} /> Copy</>}</Btn>
                  </div>
                </div>
              )}

              <div className="cluster cluster--center" style={{ marginTop: 16 }}>
                <Btn variant="primary" onClick={copyCode}><Icon name={copiedCode ? 'check' : 'copy'} size={14} /> {copiedCode ? 'Copied' : 'Copy code'}</Btn>
                <Btn onClick={copyLink}><Icon name={copiedLink ? 'check' : 'link'} size={14} /> {copiedLink ? 'Link copied' : 'Copy link'}</Btn>
                <Btn variant="ghost" onClick={reset}>New session</Btn>
              </div>

              <div style={{ marginTop: 18 }}>
                <div className="qr-wrap"><QRCodeSVG value={qrUrl} size={148} level="H" /></div>
                <div style={{ color: 'var(--text-2)', fontSize: '0.78rem', marginTop: 8 }}>Scan to join from another device</div>
              </div>

              {countdown && publishedMode === 'stored' && <div style={{ marginTop: 16, display: 'inline-flex', alignItems: 'center', gap: 8, color: 'var(--accent)', fontWeight: 700, fontSize: '0.84rem' }}><Icon name="clock" size={14} /> Expires in {countdown}</div>}
            </Card>

            {publishedMode === 'live' && (
              <Card>
                <div className="card__head">
                  <span className="card__title" style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}><span style={{ width: 8, height: 8, borderRadius: 999, background: sigColor(), boxShadow: `0 0 0 4px color-mix(in srgb, ${sigColor()} 18%, transparent)` }} /> {sigLabel()}</span>
                  <Badge tone={recipients.length ? 'success' : 'default'}><Icon name="users" size={12} /> {recipients.length === 0 ? 'Waiting…' : `${recipients.length} connected`}</Badge>
                </div>
                <div style={{ textAlign: 'center', padding: 12, background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', marginBottom: recipients.length ? 16 : 0 }}>
                  <div style={{ fontWeight: 800 }}>{recipients.length === 0 ? 'Waiting for recipients…' : `${recipients.length} peer${recipients.length > 1 ? 's' : ''} ready`}</div>
                  <div style={{ color: 'var(--text-2)', fontSize: '0.82rem', marginTop: 4 }}>They’ll receive content automatically when P2P connects.</div>
                </div>
                {recipients.length > 0 && (
                  <div className="stack stack--sm">
                    <div className="field__label">Recipients</div>
                    {recipients.map(r => (
                      <div key={r.peerId} style={{ padding: 12, background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 'var(--radius)' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontWeight: 700, fontSize: '0.84rem' }}>
                            <span style={{ width: 6, height: 6, borderRadius: 999, background: r.channelState === 'open' ? 'var(--success)' : 'var(--text-3)' }} /> Peer {r.peerId.slice(0, 4)}
                          </span>
                          <span style={{ fontSize: '0.78rem', fontWeight: 700, color: r.sendProgress ? 'var(--accent)' : 'var(--text-2)' }}>{r.sendProgress ? `${r.sendProgress.percent}%` : r.lastSentAt ? 'Delivered' : r.channelState}</span>
                        </div>
                        {r.sendProgress && (
                          <div style={{ marginTop: 10 }}>
                            <Progress percent={r.sendProgress.percent} />
                            <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 6, fontSize: '0.75rem', color: 'var(--text-2)' }}>
                              <span>{r.sendProgress.currentFile ?? ''}</span>
                              <span style={{ color: 'var(--accent)', fontWeight: 700 }}>{r.sendProgress.speed ? `${formatSpeed(r.sendProgress.speed)} · ${formatRemaining(r.sendProgress.timeRemaining || 0)} left` : ''}</span>
                            </div>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </Card>
            )}
          </div>
        )}

        {/* Receiver */}
        {view === 'join' && (
          <div className="animate-fade stack">
            <Card>
              <div className="card__head">
                <span className="card__title" style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}>
                  <Icon name={storedPayload ? 'cloud' : 'zap'} size={14} style={{ color: storedPayload ? 'var(--accent)' : channelState === 'open' ? 'var(--success)' : 'var(--text-2)' }} />
                  {storedPayload ? 'Stored session' : `P2P · ${channelLabel(channelState)}`}
                </span>
                <div className="cluster">
                  {storedPayload?.burnOnRead && <Badge tone="accent">One-time</Badge>}
                  {expiredBadge(expiresAt ?? null)}
                </div>
              </div>

              <h2 style={{ fontSize: '1.15rem', fontWeight: 850, letterSpacing: '-0.02em' }}>
                {recvProgress ? `Receiving… ${recvProgress.percent}%` : (storedPayload || received) ? 'Session content' : 'Connecting…'}
              </h2>

              {recvProgress && (
                <div style={{ marginTop: 14 }}>
                  <Progress percent={recvProgress.percent} />
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 8, fontSize: '0.82rem', color: 'var(--text-2)' }}>
                    <span style={{ fontWeight: 600 }}>{recvProgress.currentFile}</span>
                    <span style={{ color: 'var(--accent)', fontWeight: 700 }}>{recvProgress.speed ? `${formatSpeed(recvProgress.speed)} · ${formatRemaining(recvProgress.timeRemaining || 0)}` : ''}</span>
                  </div>
                </div>
              )}

              {(storedPayload || received) ? (
                <div className="stack" style={{ marginTop: 18, textAlign: 'left' }}>
                  {(storedPayload?.text || received?.text) && (
                    <div>
                      <div className="field__label" style={{ marginBottom: 8 }}>Message</div>
                      <div style={{ padding: '14px 16px', background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', whiteSpace: 'pre-wrap', lineHeight: 1.6, fontSize: '0.94rem' }}>
                        {storedPayload?.text || received?.text}
                      </div>
                    </div>
                  )}
                  {(storedPayload?.files?.length || received?.files?.length) ? (
                    <div>
                      <div className="field__label" style={{ marginBottom: 8 }}>Files · {(storedPayload?.files || received?.files || []).length}</div>
                      {storedPayload?.burnOnRead && <div className="callout callout--warn" style={{ marginBottom: 10 }}><Icon name="alert" size={14} /> One-time session — files are preloaded; server copy self-destructs shortly.</div>}
                      <div className="stack stack--sm">
                        {(storedPayload?.files || received?.files || []).map((f, i) => (
                          <div key={i} className="file-row">
                            <span className="file-row__icon"><Icon name="file" size={16} /></span>
                            <div className="file-row__meta">
                              <div className="file-row__name">{f.name}</div>
                              {'size' in f && <div className="file-row__size">{formatBytes((f as { size: number }).size)}</div>}
                            </div>
                            <div className="cluster">
                              <Btn size="sm" onClick={() => 'fileId' in f ? handleStoredPreview(f as StoredFileInfo) : handleLivePreview(f as ReceivedFile)}><Icon name="eye" size={12} /> View</Btn>
                              <Btn size="sm" variant="primary" onClick={() => 'fileId' in f ? handleStoredDownload(f as StoredFileInfo) : handleLiveDownload(f as ReceivedFile)}><Icon name="download" size={12} /> Get</Btn>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  ) : null}
                </div>
              ) : !recvProgress ? (
                <div style={{ padding: '18px 0', display: 'grid', placeItems: 'center', gap: 10, color: 'var(--text-2)' }}>
                  <Spinner size={22} style={{ color: 'var(--accent)' }} />
                  <span style={{ fontSize: '0.86rem', fontWeight: 600 }}>Establishing secure connection…</span>
                </div>
              ) : null}
            </Card>

            {storedPayload && (
              <AiChat
                code={code}
                apiBase={API_URL}
                aiStatus={aiStatus}
                onStatusChange={setAiStatus}
                onAsk={askAi}
                onOpenSource={(src) => {
                  const stored = storedPayload?.files.find(f => f.fileId === src.fileId)
                  if (stored) { void handleStoredPreview(stored, src.page); return }
                  const live = received?.files.find(f => f.name === src.name)
                  if (live) handleLivePreview(live)
                  else toast('Source file is no longer available in this view.', 'error')
                }}
              />
            )}

            <div className="cluster cluster--center">
              <Btn variant="ghost" onClick={reset}>Exit session</Btn>
              <Btn onClick={() => { navigator.clipboard.writeText(window.location.href); toast('Link copied', 'success') }}><Icon name="link" size={12} /> Copy link</Btn>
            </div>
          </div>
        )}
      </main>

      <footer className="site-footer">
        <div className="container">QuickShare · P2P WebRTC · Cloud + E2EE · RAG AI · Built for speed and privacy</div>
      </footer>
    </div>
  )
}

function expiredBadge(expiresAt: number | null) {
  if (!expiresAt) return null
  const ms = expiresAt - Date.now()
  if (ms <= 0) return <Badge>Expired</Badge>
  return <Badge><Icon name="clock" size={10} /> {formatCountdown(ms)} left</Badge>
}

function DurationPicker({ ttlSeconds, setStoredDuration }: { ttlSeconds: number, setStoredDuration: (h: number, m: number) => void }) {
  const parts = splitStoredTtl(ttlSeconds)
  const partsRef = useRef(parts)
  useEffect(() => { partsRef.current = parts })
  const stepHours = (delta: number) => { const cur = partsRef.current; setStoredDuration(cur.hours + delta, cur.minutes) }
  const stepMinutes = (delta: number) => { const cur = partsRef.current; setStoredDuration(cur.hours, cur.minutes + delta) }
  return (
    <div style={{ padding: 12, background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 'var(--radius)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <span className="field__label" style={{ margin: 0 }}><Icon name="clock" size={12} /> Session expiry</span>
        <Badge tone="accent">{formatTTL(ttlSeconds)}</Badge>
      </div>
      <div className="cluster">
        <Stepper value={parts.hours} label="hr" onStep={stepHours} />
        <Stepper value={parts.minutes} label="min" onStep={stepMinutes} />
      </div>
    </div>
  )
}
function Stepper({ value, label, onStep }: { value: number, label: string, onStep: (d: number) => void }) {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const startChange = (delta: number) => {
    onStep(delta)
    timerRef.current = setTimeout(() => { intervalRef.current = setInterval(() => { onStep(delta) }, 80) }, 400)
  }
  const stopChange = () => {
    if (timerRef.current) clearTimeout(timerRef.current)
    if (intervalRef.current) clearInterval(intervalRef.current)
    timerRef.current = null; intervalRef.current = null
  }
  useEffect(() => stopChange, [])
  return (
    <span className="stepper">
      <button className="stepper__btn" aria-label={`Decrease ${label}`} onMouseDown={() => startChange(-1)} onMouseUp={stopChange} onMouseLeave={stopChange} onTouchStart={() => startChange(-1)} onTouchEnd={stopChange}>−</button>
      <span className="stepper__value">{String(value).padStart(2, '0')}</span>
      <button className="stepper__btn" aria-label={`Increase ${label}`} onMouseDown={() => startChange(1)} onMouseUp={stopChange} onMouseLeave={stopChange} onTouchStart={() => startChange(1)} onTouchEnd={stopChange}>＋</button>
      <span className="stepper__unit">{label}</span>
    </span>
  )
}
