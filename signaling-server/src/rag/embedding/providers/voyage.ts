import { CONFIG } from '../../../config'
import type { EmbedInputType, EmbedOptions, EmbeddingProvider } from '../provider'
import { estimateTokens } from '../../analyzer'

// ── Voyage embedding provider (v1 REST) ─────────────────────────────────────
// Rate limits are TIER-DEPENDENT and treated as CONFIG DATA (review §2):
// cardless trials are heavily throttled, Tier-1 (payment method on file,
// still free within the 200M token allowance) allows 16M TPM on -lite.
// The breaker + pacing handle whichever reality applies.

const ENDPOINT = 'https://api.voyageai.com/v1/embeddings'
const MAX_ITEMS = 128
const MAX_TOKENS_PER_REQUEST = 28_000

export class VoyageProvider implements EmbeddingProvider {
  readonly id = 'voyage'
  readonly generationId: string
  private lastCallAt = 0

  constructor(
    private readonly apiKey: string,
    private readonly fetchImpl: typeof fetch,
  ) {
    this.generationId = `voyage:${CONFIG.VOYAGE_EMBED_MODEL}:${CONFIG.VOYAGE_EMBED_DIM}:cosine`
  }

  private async pace(): Promise<void> {
    const wait = CONFIG.PROVIDER_MIN_INTERVAL_MS - (Date.now() - this.lastCallAt)
    if (wait > 0) await new Promise(r => setTimeout(r, wait))
    this.lastCallAt = Date.now()
  }

  async embed(texts: string[], opts: EmbedOptions = {}): Promise<number[][]> {
    const inputType: EmbedInputType = opts.inputType === 'query' ? 'query' : 'document'
    const out: number[][] = []
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
          model: CONFIG.VOYAGE_EMBED_MODEL,
          input: texts,
          input_type: inputType,
          output_dimension: CONFIG.VOYAGE_EMBED_DIM,
        }),
      })
      if (!res.ok) {
        const detail = await res.text().catch(() => '')
        const err = new Error(`voyage embed ${res.status}: ${detail.slice(0, 200)}`)
        ;(err as { status?: number }).status = res.status
        throw err
      }
      const json = (await res.json()) as { data?: { embedding: number[] }[] }
      if (!Array.isArray(json.data)) throw new Error('voyage response missing data[]')
      return json.data.map(d => d.embedding)
    } finally {
      clearTimeout(timer)
    }
  }
}
