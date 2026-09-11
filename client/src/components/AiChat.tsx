import { useState, useRef, useEffect } from 'react'

export interface AiSource { name: string; fileId: string; page: number | null; score: number; snippet: string }
interface ChatMessage { role: 'user' | 'assistant'; text: string; sources?: AiSource[]; error?: boolean; streaming?: boolean }
export interface AskResult { answer: string; refused?: boolean; sources?: AiSource[]; error?: string; status?: number; groqStatus?: number }
interface AiChatProps {
  code: string; apiBase: string; aiStatus: 'none' | 'pending' | 'ready' | 'failed'
  onStatusChange?: (status: 'ready' | 'failed') => void
  onOpenSource?: (source: AiSource) => void
  onAsk: (question: string, cbs?: { onDelta?: (t: string) => void; onSources?: (s: AiSource[]) => void; onDone?: (fullText: string, refused: boolean, cached: boolean) => void }) => Promise<AskResult>
}

function dedupeSources(sources: AiSource[]): AiSource[] {
  const seen = new Map<string, AiSource>()
  for (const s of sources) {
    const key = `${s.fileId}:${s.page ?? 'null'}:${s.name}`
    if (!seen.has(key)) seen.set(key, s)
  }
  // Cap to avoid chip spam for enumeration queries (wide-recall can be 40+ blocks)
  return Array.from(seen.values()).slice(0, 16)
}

export function AiChat({ code, apiBase, aiStatus, onStatusChange, onOpenSource, onAsk }: AiChatProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [expanded, setExpanded] = useState<Set<number>>(new Set())
  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => { scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' }) }, [messages, busy])

  useEffect(() => {
    if (aiStatus !== 'pending') return
    let stop = false
    const tick = async () => {
      try {
        const res = await fetch(`${apiBase.replace(/\/$/, '')}/ai/status/${code}`)
        const data = await res.json()
        if (!stop && (data.aiStatus === 'ready' || data.aiStatus === 'failed')) onStatusChange?.(data.aiStatus)
      } catch { /* keep polling */ }
    }
    const iv = setInterval(tick, 4000); tick()
    return () => { stop = true; clearInterval(iv) }
  }, [aiStatus, code, apiBase, onStatusChange])

  async function send() {
    const q = input.trim(); if (!q || busy) return
    setInput('')
    setMessages(prev => [...prev, { role: 'user', text: q }, { role: 'assistant', text: '', streaming: true }])
    const patchLast = (map: (prev: ChatMessage) => Partial<ChatMessage>) =>
      setMessages(prev => {
        const next = [...prev]; const last = next[next.length - 1]
        if (last?.role === 'assistant') next[next.length - 1] = { ...last, ...map(last) }
        return next
      })
    setBusy(true)
    try {
      const r = await onAsk(q, {
        onSources: (srcs: AiSource[]) => patchLast(() => ({ sources: dedupeSources(srcs) })),
        onDelta: (t: string) => patchLast(prev => ({ text: prev.text + t })),
        onDone: (fullText: string) => patchLast(() => ({ text: fullText, streaming: false })),
      })
      if (r.error) {
        const friendly =
          r.error === 'ai_busy' ? 'AI is rate-limited right now — try again in a few minutes.' :
            r.error === 'ai_config' ? 'AI model/key misconfigured on the server.' :
              r.error === 'ai_not_configured' ? 'AI answering needs the operator to configure GROQ_API_KEY.' :
                r.error === 'ai_session_quota' ? 'AI query limit reached for this session — try again later.' :
                  r.error === 'ai_error' ? `Groq API error${r.groqStatus ? ` (HTTP ${r.groqStatus})` : ''} — try again.` :
                    r.error === 'indexing' ? 'Still indexing this session — one moment.' :
                      r.error === 'expired' || r.error === 'not_found' ? 'This session has expired and was cleaned up.' :
                        r.error === 'burned' ? 'One-time session already consumed.' :
                          r.error === 'private' ? 'Private session — AI features are off.' :
                            r.error === 'network' ? 'Could not reach the server (it may be waking from sleep). Retrying usually works.' :
                              r.status === 400 ? 'Invalid request — check your question and try again.' :
                                r.status === 404 ? 'Session not found — it may have expired.' :
                                  r.status === 429 ? 'Too many requests — wait a moment and try again.' :
                                    r.status === 503 ? 'Service temporarily unavailable — try again shortly.' :
                                      r.status === 500 ? 'Server hit an unexpected error answering this question. Try again.' :
                                        'AI request failed. Try again.'
        setMessages(prev => {
          const next = [...prev]; const last = next[next.length - 1]
          // Streaming placeholder exists — reuse it for the error; otherwise append
          if (last?.role === 'assistant') {
            // Empty placeholder (no deltas yet) -> replace with error
            if (last.text === '' && last.streaming) {
              next[next.length - 1] = { ...last, text: friendly, error: true, streaming: false }; return next
            }
            // Mid-stream error with partial content -> keep partial and append error bubble
            if (last.streaming) {
              next[next.length - 1] = { ...last, streaming: false }
              return [...next, { role: 'assistant', text: friendly, error: true }]
            }
            // Already-finished streaming bubble (onDone set streaming false) + error from non-streaming fallback
            if (last.text === '') {
              next[next.length - 1] = { ...last, text: friendly, error: true, streaming: false }; return next
            }
          }
          return [...next, { role: 'assistant', text: friendly, error: true }]
        })
      } else {
        // Streaming placeholder was already populated via onDelta/onDone/onSources.
        // Do NOT append a duplicate. Just ensure it is finalized and has sources/text.
        setMessages(prev => {
          const next = [...prev]
          const last = next[next.length - 1]
          if (last?.role === 'assistant') {
            const finalSources = dedupeSources(r.sources ?? last.sources ?? [])
            const finalText = last.text || r.answer || ''
            // If still streaming (non-SSE fallback never called onDone), finalize it
            if (last.streaming) {
              next[next.length - 1] = { ...last, text: finalText, sources: finalSources, streaming: false }
              return next
            }
            // Already finalized via onDone — just ensure sources/text are present (dedupe)
            if (last.text !== finalText || JSON.stringify(last.sources) !== JSON.stringify(finalSources)) {
              next[next.length - 1] = { ...last, text: finalText, sources: finalSources }
            }
            return next
          }
          return [...next, { role: 'assistant', text: r.answer, sources: dedupeSources(r.sources ?? []) }]
        })
      }
    } catch {
      setMessages(prev => [...prev, { role: 'assistant', text: 'Network error reaching the AI endpoint.', error: true }])
    }
    setBusy(false)
    requestAnimationFrame(() => inputRef.current?.focus())
  }

  if (aiStatus === 'none') {
    return (
      <div className="card card--pad" style={{ display: 'flex', alignItems: 'center', gap: 10, justifyContent: 'center', color: 'var(--text-2)' }}>
        <span style={{ width: 28, height: 28, borderRadius: 999, display: 'grid', placeItems: 'center', background: 'var(--surface-2)', border: '1px solid var(--border)' }}>🔒</span>
        <span style={{ fontSize: '0.86rem', fontWeight: 650 }}>Private session — AI features are off.</span>
      </div>
    )
  }
  if (aiStatus === 'failed') {
    return (
      <div className="card card--pad" style={{ textAlign: 'center', borderColor: 'var(--error)' }}>
        <div style={{ fontWeight: 800, color: 'var(--error)', fontSize: '0.9rem' }}>Indexing failed</div>
        <div style={{ color: 'var(--text-2)', fontSize: '0.84rem', marginTop: 4 }}>AI questions are unavailable for this session.</div>
      </div>
    )
  }
  if (aiStatus === 'pending') {
    return (
      <div className="card card--pad" style={{ display: 'flex', alignItems: 'center', gap: 10, justifyContent: 'center' }}>
        <span style={{ width: 16, height: 16, border: '2px solid var(--border-strong)', borderTopColor: 'var(--accent)', borderRadius: 999, display: 'inline-block', animation: 'spin 0.9s linear infinite' }} />
        <span style={{ fontSize: '0.86rem', color: 'var(--text-2)', fontWeight: 600 }}>Indexing files for AI questions…</span>
      </div>
    )
  }

  const suggestions = ['Summarise the documents', 'List key points', 'What tables are in the file?']

  return (
    <div className="card card--pad">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
        <span className="field__label" style={{ margin: 0, display: 'inline-flex', gap: 6, alignItems: 'center' }}><span style={{ color: 'var(--accent)' }}>✦</span> Ask about these files</span>
        <span style={{ fontSize: '0.7rem', fontWeight: 800, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--text-3)', border: '1px solid var(--border)', padding: '4px 8px', borderRadius: 999, background: 'var(--surface-2)' }}>RAG · cited</span>
      </div>

      <div
        ref={scrollRef}
        style={{
          maxHeight: 320, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 10,
          padding: 4, marginBottom: 12, scrollBehavior: 'smooth'
        }}
      >
        {messages.length === 0 && (
          <div className="callout" style={{ flexDirection: 'column', gap: 8 }}>
            <div style={{ fontSize: '0.86rem', color: 'var(--text-2)', lineHeight: 1.5 }}>Ask anything grounded in the session files. Answers include source citations — click a chip to open the file at that page.</div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {suggestions.map(s => (
                <button
                  key={s}
                  onClick={() => setInput(s)}
                  style={{
                    fontSize: '0.78rem', fontWeight: 650, padding: '6px 10px', borderRadius: 999,
                    background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--text-2)', cursor: 'pointer'
                  }}
                >{s}</button>
              ))}
            </div>
          </div>
        )}
        {messages.map((m, i) => (
          <div
            key={i}
            style={{
              alignSelf: m.role === 'user' ? 'flex-end' : 'flex-start',
              maxWidth: '88%',
              padding: '10px 13px',
              borderRadius: 16,
              borderBottomRightRadius: m.role === 'user' ? 6 : 16,
              borderBottomLeftRadius: m.role === 'user' ? 16 : 6,
              background: m.role === 'user' ? 'var(--accent)' : m.error ? 'var(--error-soft)' : 'var(--surface-2)',
              color: m.role === 'user' ? 'var(--accent-fg)' : m.error ? 'var(--error)' : 'var(--text)',
              border: m.role === 'user' ? '1px solid var(--accent)' : `1px solid ${m.error ? 'var(--error)' : 'var(--border)'}`,
              whiteSpace: 'pre-wrap', fontSize: '0.88rem', lineHeight: 1.55,
              boxShadow: 'var(--shadow-sm)',
            }}
          >
            {m.streaming && !m.text ? <span style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}><span style={{ width: 4, height: 4, borderRadius: 999, background: 'var(--text-2)', animation: 'pulse 1s infinite' }} /><span style={{ width: 4, height: 4, borderRadius: 999, background: 'var(--text-2)', animation: 'pulse 1s 0.2s infinite' }} /><span style={{ width: 4, height: 4, borderRadius: 999, background: 'var(--text-2)', animation: 'pulse 1s 0.4s infinite' }} /></span> : m.text}
            {m.sources && m.sources.length > 0 && (() => {
              const MAX = 8
              const isExpanded = expanded.has(i)
              const visible = isExpanded ? m.sources : m.sources.slice(0, MAX)
              const hidden = m.sources.length - visible.length
              return (
                <div style={{ marginTop: 8, display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
                  {visible.map((s, j) => (
                    <button
                      key={`${s.fileId}:${s.page ?? 'null'}:${j}`}
                      title={s.snippet}
                      onClick={() => onOpenSource?.(s)}
                      style={{
                        fontSize: '0.72rem', fontWeight: 700, padding: '4px 8px', borderRadius: 999,
                        background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--text-2)', cursor: onOpenSource ? 'pointer' : 'default',
                        display: 'inline-flex', gap: 4, alignItems: 'center'
                      }}
                    >📄 {s.name}{s.page != null ? ` p.${s.page}` : ''}</button>
                  ))}
                  {hidden > 0 && (
                    <button
                      onClick={() => setExpanded(prev => { const n = new Set(prev); n.add(i); return n })}
                      style={{ fontSize: '0.72rem', fontWeight: 700, padding: '4px 10px', borderRadius: 999, background: 'var(--surface-2)', border: '1px dashed var(--border-strong)', color: 'var(--text-2)', cursor: 'pointer' }}
                    >+{hidden} more</button>
                  )}
                  {isExpanded && m.sources.length > MAX && (
                    <button
                      onClick={() => setExpanded(prev => { const n = new Set(prev); n.delete(i); return n })}
                      style={{ fontSize: '0.72rem', fontWeight: 700, padding: '4px 8px', borderRadius: 999, background: 'transparent', border: '1px solid var(--border)', color: 'var(--text-3)', cursor: 'pointer' }}
                    >Show less</button>
                  )}
                </div>
              )
            })()}
          </div>
        ))}
        {busy && !messages.some(x => x.streaming) && (
          <div style={{ alignSelf: 'flex-start', display: 'inline-flex', gap: 8, alignItems: 'center', color: 'var(--text-2)', fontSize: '0.84rem', fontWeight: 600, padding: '8px 4px' }}>
            <span style={{ width: 14, height: 14, border: '2px solid var(--border-strong)', borderTopColor: 'var(--accent)', borderRadius: 999, display: 'inline-block', animation: 'spin 0.8s linear infinite' }} /> Thinking…
          </div>
        )}
      </div>

      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <input
          ref={inputRef}
          className="input"
          value={input}
          placeholder="Ask a question…"
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() } }}
          disabled={busy}
          style={{ flex: 1 }}
          aria-label="Ask about these files"
        />
        <button className="btn btn--primary" onClick={send} disabled={busy || !input.trim()} style={{ padding: '11px 16px' }}>
          {busy ? <span style={{ width: 16, height: 16, border: '2px solid rgba(255,255,255,0.3)', borderTopColor: '#fff', borderRadius: 999, display: 'inline-block', animation: 'spin 0.7s linear infinite' }} /> : 'Ask'}
        </button>
      </div>
      <div style={{ marginTop: 8, fontSize: '0.72rem', color: 'var(--text-3)', textAlign: 'center' }}>AI answers are grounded in your files — off-topic questions are refused.</div>
    </div>
  )
}
