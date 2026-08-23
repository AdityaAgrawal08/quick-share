// ── Identical-question answer cache ──────────────────────────────────────────
// Saves Groq free-quota when the same question is asked repeatedly within a
// session's lifetime. Keyed by (code, normalized question); FIFO-bounded.
//
// Lifecycle:
//  • populated after a successful Groq answer
//  • read BEFORE calling Groq in /ai/query
//  • cleared with the session's index via clearAnswerCache(code) — called by
//    the retriever's dropSessionIndex and after re-index jobs

export interface CachedAnswer {
  answer: string
  refused: boolean
  sources: { name: string; fileId: string; page: number | null; score: number; snippet: string }[]
}

const MAX_ENTRIES = 200

const cache = new Map<string, CachedAnswer>()

function key(code: string, question: string): string {
  const q = question.trim().toLowerCase().replace(/\s+/g, ' ')
  return `${code}::${q}`
}

export function getAnswer(code: string, question: string): CachedAnswer | undefined {
  const k = key(code, question)
  const hit = cache.get(k)
  if (hit) {
    // LRU touch
    cache.delete(k)
    cache.set(k, hit)
  }
  return hit
}

export function putAnswer(code: string, question: string, value: CachedAnswer): void {
  cache.set(key(code, question), value)
  while (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next().value as string | undefined
    if (!oldest) break
    cache.delete(oldest)
  }
}

export function clearAnswerCache(code: string): void {
  const prefix = `${code}::`
  for (const k of cache.keys()) {
    if (k.startsWith(prefix)) cache.delete(k)
  }
}

/** Test/debug visibility. */
export function answerCacheSize(): number {
  return cache.size
}
