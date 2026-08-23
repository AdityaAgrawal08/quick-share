import { useState, useRef, useEffect } from 'react'

export interface AiSource {
  name: string
  fileId: string
  page: number | null
  score: number
  snippet: string
}

interface ChatMessage {
  role: 'user' | 'assistant'
  text: string
  sources?: AiSource[]
  error?: boolean
}

export interface AskResult {
  answer: string
  refused?: boolean
  sources?: AiSource[]
  error?: string
  /** HTTP status when the server rejected the request (drives better copy). */
  status?: number
}

interface AiChatProps {
  code: string
  apiBase: string
  aiStatus: 'none' | 'pending' | 'ready' | 'failed'
  /** Called when background polling observes a terminal index status. */
  onStatusChange?: (status: 'ready' | 'failed') => void
  /** Clicking a citation chip — opens the referenced file at its page. */
  onOpenSource?: (source: AiSource) => void
  onAsk: (question: string) => Promise<AskResult>
}

export function AiChat({ code, apiBase, aiStatus, onStatusChange, onOpenSource, onAsk }: AiChatProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [polling, setPolling] = useState(aiStatus === 'pending')
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
  }, [messages])

  // Poll while indexing so the drawer unlocks itself when ready.
  useEffect(() => {
    if (aiStatus !== 'pending') return
    let stop = false
    const tick = async () => {
      try {
        const res = await fetch(`${apiBase.replace(/\/$/, '')}/ai/status/${code}`)
        const data = await res.json()
        if (!stop && (data.aiStatus === 'ready' || data.aiStatus === 'failed')) {
          setPolling(false)
          onStatusChange?.(data.aiStatus)
        }
      } catch { /* transient — keep polling */ }
    }
    const iv = setInterval(tick, 4000)
    tick()
    return () => { stop = true; clearInterval(iv) }
  }, [aiStatus, code, apiBase, onStatusChange])

  async function send() {
    const q = input.trim()
    if (!q || busy) return
    setInput('')
    setMessages(prev => [...prev, { role: 'user', text: q }])
    setBusy(true)
    try {
      const r = await onAsk(q)
      if (r.error) {
        const friendly =
          r.error === 'ai_busy' ? 'AI is rate-limited right now — try again in a few minutes.' :
          r.error === 'indexing' ? 'Still indexing this session — one moment.' :
          r.error === 'expired' || r.error === 'not_found' ? 'This session has expired and was cleaned up.' :
          r.error === 'burned' ? 'One-time session already consumed.' :
          r.error === 'ai_not_configured' ? 'AI answering needs the operator to configure GROQ_API_KEY. Retrieval worked though.' :
          r.error === 'ai_config' ? 'AI model/key misconfigured on the server — contact the operator.' :
          r.error === 'private' ? 'Private session — AI features are off.' :
          r.error === 'network' ? 'Could not reach the server (it may be waking from sleep). Retrying usually works.' :
          r.status === 500 ? 'Server hit an unexpected error answering this question. Try again.' :
          'AI request failed. Try again.'
        setMessages(prev => [...prev, { role: 'assistant', text: friendly, error: true }])
      } else {
        setMessages(prev => [...prev, { role: 'assistant', text: r.answer, sources: r.sources }])
      }
    } catch {
      setMessages(prev => [...prev, { role: 'assistant', text: 'Network error reaching the AI endpoint.', error: true }])
    }
    setBusy(false)
  }

  if (aiStatus === 'none') {
    return (
      <Card>
        <p style={{ fontSize: '0.8125rem', color: 'var(--text-dim)', textAlign: 'center' }}>
          🔒 Private session — AI features are off.
        </p>
      </Card>
    )
  }

  if (aiStatus === 'failed') {
    return (
      <Card>
        <p style={{ fontSize: '0.8125rem', color: 'var(--error)', textAlign: 'center' }}>
          Indexing failed for this session — AI questions unavailable.
        </p>
      </Card>
    )
  }

  if (aiStatus === 'pending' || polling) {
    return (
      <Card>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', justifyContent: 'center', padding: '1rem' }}>
          <span className="spin" style={{ width: 14, height: 14 }} />
          <p style={{ fontSize: '0.8125rem', color: 'var(--text-dim)' }}>Indexing files for AI questions…</p>
        </div>
      </Card>
    )
  }

  return (
    <Card>
      <label style={{ display: 'block', fontSize: '0.75rem', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.1em', color: 'var(--text-dim)', marginBottom: '0.75rem' }}>
        ✦ Ask about these files
      </label>

      <div ref={scrollRef} style={{ maxHeight: 260, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 10, marginBottom: '0.75rem' }}>
        {messages.length === 0 && (
          <p style={{ fontSize: '0.8125rem', color: 'var(--text-dim)' }}>
            Try: “Summarise the documents” or ask anything specific from the files.
          </p>
        )}
        {messages.map((m, i) => (
          <div key={i} style={{
            alignSelf: m.role === 'user' ? 'flex-end' : 'flex-start',
            maxWidth: '92%',
            padding: '8px 12px',
            borderRadius: '12px',
            background: m.role === 'user' ? 'var(--accent)' : 'var(--surface-hi)',
            color: m.role === 'user' ? '#fff' : (m.error ? 'var(--error)' : 'var(--text)'),
            border: m.role === 'user' ? 'none' : '1px solid var(--border)',
            whiteSpace: 'pre-wrap',
            fontSize: '0.875rem',
            lineHeight: 1.45,
          }}>
            {m.text}
            {m.sources && m.sources.length > 0 && (
              <div style={{ marginTop: 6, display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                {m.sources.map((s, j) => (
                  <button key={j}
                    title={s.snippet}
                    onClick={() => onOpenSource?.(s)}
                    style={{
                      fontSize: '0.6875rem', padding: '2px 8px', borderRadius: 999,
                      background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--text-dim)',
                      cursor: onOpenSource ? 'pointer' : 'default',
                    }}
                  >
                    📄 {s.name}{s.page != null ? ` p.${s.page}` : ''}
                  </button>
                ))}
              </div>
            )}
          </div>
        ))}
        {busy && <div style={{ alignSelf: 'flex-start', color: 'var(--text-dim)', fontSize: '0.8125rem' }}>Thinking…</div>}
      </div>

      <div style={{ display: 'flex', gap: 8 }}>
        <input
          className="input"
          value={input}
          placeholder="Ask a question…"
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && send()}
        />
        <button className="btn btn-primary" onClick={send} disabled={busy || !input.trim()} style={{ padding: '0 1rem' }}>Ask</button>
      </div>
    </Card>
  )
}

function Card({ children }: { children: React.ReactNode }) {
  return <div style={{ marginTop: '1.25rem', border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: '1rem', background: 'var(--surface)' }}>{children}</div>
}
