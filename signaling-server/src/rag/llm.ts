import { CONFIG } from '../config'
import logger from '../logger'

// ── LLM provider: Groq (free tier, OpenAI-compatible) ───────────────────────
// Default model: llama-3.3-70b-versatile. Swap via GROQ_MODEL env if quotas
// or availability change. Kept behind this module so route code never changes.

export interface LlmAnswer {
  text: string
  refused: boolean
}

const SYSTEM_PROMPT = [
  'You answer questions STRICTLY from the provided context snippets.',
  'Rules:',
  '1. Use ONLY the numbered context blocks [[1]]..[[n]]. Never use outside knowledge.',
  '2. Cite inline after each claim as [name] or [name p.X].',
  '3. If the context does not contain the answer, reply exactly:',
  '   "I could not find that in the shared files." and nothing else.',
  '4. Be concise. Prefer short paragraphs or bullet lists.',
].join('\n')

export function llmConfigured(): boolean {
  return !!CONFIG.GROQ_API_KEY
}

export interface StreamEvents {
  onDelta: (t: string) => void
}

// Groq upstream SSE line parser: `data: {"choices":[{"delta":{"content":".."}}]}`
async function* upstreamDeltas(res: Response): AsyncGenerator<string> {
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    let nl: number
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim()
      buf = buf.slice(nl + 1)
      if (!line.startsWith('data:')) continue
      const payload = line.slice(5).trim()
      if (payload === '[DONE]') return
      try {
        const j = JSON.parse(payload)
        const t = j.choices?.[0]?.delta?.content
        if (t) yield t
      } catch { /* partial line — keep buffering */ }
    }
  }
}

/** Streaming variant of generateAnswer. Yields deltas; final yield carries the full text. */
export async function* streamAnswer(question: string, context: string): AsyncGenerator<string> {
  if (!CONFIG.GROQ_API_KEY) throw new Error('llm_not_configured')

  const body = {
    model: CONFIG.GROQ_MODEL,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: `Context:\n${context}\n\nQuestion: ${question}` },
    ],
    temperature: 0.2,
    max_tokens: 1024,
    stream: true,
  }

  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${CONFIG.GROQ_API_KEY}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  })

  if (!res.ok || !res.body) {
    const detail = res.body ? await res.text().catch(() => '') : ''
    logger.warn({ status: res.status, detail: detail.slice(0, 200) }, '[llm] Groq stream error')
    if (res.status === 429 || res.status === 503) throw new Error('ai_busy')
    if (res.status >= 400 && res.status <= 404) throw new Error('ai_config')
    throw new Error('ai_error')
  }

  let full = ''
  for await (const t of upstreamDeltas(res)) {
    full += t
    yield t
  }
  const text = full.trim() || 'The model returned an empty response.'
  yield `__FULL__${JSON.stringify({ text, refused: /could not find that in the shared files/i.test(text) })}`
}

export async function generateAnswer(
  question: string,
  context: string
): Promise<LlmAnswer> {
  if (!CONFIG.GROQ_API_KEY) throw new Error('llm_not_configured')

  const body = {
    model: CONFIG.GROQ_MODEL,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: `Context:\n${context}\n\nQuestion: ${question}` },
    ],
    temperature: 0.2,
    max_tokens: 1024,
  }

  const callGroq = () => fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${CONFIG.GROQ_API_KEY}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  })

  // One retry for transient failures (network blip, 5xx). Config errors
  // (4xx) are never retried — they will fail identically.
  let res = await callGroq()
  if ((!res.ok && res.status >= 500)) {
    await new Promise(r => setTimeout(r, 700))
    res = await callGroq()
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    logger.warn({ status: res.status, detail: detail.slice(0, 200) }, '[llm] Groq error')
    if (res.status === 429 || res.status === 503) throw new Error('ai_busy')
    // 400 covers model_not_found / bad params; 401/403 cover key issues.
    if (res.status === 400 || res.status === 401 || res.status === 403 || res.status === 404) throw new Error('ai_config')
    throw new Error('ai_error')
  }

  const json = (await res.json()) as {
    choices?: { message?: { content?: string } }[]
  }
  const text = (json.choices?.[0]?.message?.content ?? '').trim()

  const refused = /could not find that in the shared files/i.test(text)
  return { text: text || 'The model returned an empty response.', refused }
}
