import { CONFIG } from '../../../config'
import type { EmbedInputType, EmbedOptions, EmbeddingProvider } from '../provider'
import { estimateTokens } from '../../analyzer'

// ── Cohere embedding provider (embed-v4, REST v2) ───────────────────────────
// Limits as CONFIG DATA (review §2/§20 — never hardcode stale quotas):
//   max 96 inputs/request · trial keys also capped monthly (1k calls).
// Errors are thrown with `.status` so classifyEmbeddingError can bucket them
// (429→quota cooldown, 401→auth disable, …) and the shared breaker reacts.

const ENDPOINT = 'https://api.cohere.com/v2/embed'
/** Hard request caps — conservative token slice on top of the item cap. */
const MAX_ITEMS = 96
const MAX_TOKENS_PER_REQUEST = 24_000

export class CohereProvider implements EmbeddingProvider {
  readonly id = 'cohere'
  readonly generationId: string
  private lastCallAt = 0

  constructor(
    private readonly apiKey: string,
    private readonly fetchImpl: typeof fetch,
  ) {
    this.generationId = `cohere:${CONFIG.COHERE_EMBED_MODEL}:${CONFIG.COHERE_EMBED_DIM}:cosine`
  }

  private async pace(): Promise<void> {
    const wait = CONFIG.PROVIDER_MIN_INTERVAL_MS - (Date.now() - this.lastCallAt)
    if (wait > 0) await new Promise(r => setTimeout(r, wait))
    this.lastCallAt = Date.now()
  }

  async embed(texts: string[], opts: EmbedOptions = {}): Promise<number[][]> {
    const inputType: EmbedInputType = opts.inputType ?? 'document'
    const out: number[][] = []
    // Token-aware slicing (review §7/§10): items AND estimated tokens bound.
    let slice: string[] = []
    let sliceTokens = 0
    const flush = async () => {
      if (slice.length === 0) return
      out.push(...await this.request(slice, inputType))
      slice = []
      sliceTokens = 0
    }
    for (const t of texts) {
      const tok = estimateTokens(t.length)
      if (slice.length >= MAX_ITEMS || sliceTokens + tok > MAX_TOKENS_PER_REQUEST) await flush()
      slice.push(t)
      sliceTokens += tok
    }
    await flush()
    return out
  }

  private async request(texts: string[], inputType: EmbedInputType): Promise<number[][]> {
    await this.pace()
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), CONFIG.PROVIDER_TIMEOUT_MS)
    try {
      const res = await this.fetchImpl(ENDPOINT, {
        method: 'POST',
        signal: ctrl.signal,
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: CONFIG.COHERE_EMBED_MODEL,
          texts,
          input_type: inputType,
          embedding_types: ['float'],
          output_dimension: CONFIG.COHERE_EMBED_DIM,
        }),
      })
      if (!res.ok) {
        const detail = await res.text().catch(() => '')
        const err = new Error(`cohere embed ${res.status}: ${detail.slice(0, 200)}`)
        ;(err as { status?: number }).status = res.status
        throw err
      }
      const json = (await res.json()) as { embeddings?: { float?: number[][] } }
      const vectors = json.embeddings?.float
      if (!Array.isArray(vectors)) throw new Error('cohere response missing embeddings.float')
      return vectors
    } finally {
      clearTimeout(timer)
    }
  }
}
