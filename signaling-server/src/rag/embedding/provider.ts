// ── Embedding provider contract ─────────────────────────────────────────────
// A provider is a REPLACEABLE computation engine (architecture doc §19/§42):
// Quick-Share owns chunks/job state; the provider only turns text into
// vectors. Every provider stamps its output with a generation id so vectors
// from different embedding spaces can never be silently mixed (§35, §37).

export type EmbedInputType = 'document' | 'query'

export interface EmbedOptions {
  /** Retrieval intent — several APIs apply asymmetric instruction prefixes. */
  inputType?: EmbedInputType
  /** Conservative token estimate for THIS call — feeds health-aware selection. */
  estimatedTokens?: number
}

export interface EmbeddingProvider {
  /** Stable identifier, e.g. 'cohere' | 'voyage' | 'local-bge'. */
  readonly id: string
  /**
   * FULL vector-space identity: provider:model:dimension:metric — e.g.
   * 'cohere:embed-v4.0:1536:cosine'. Vectors carry this; retrieval refuses to
   * query across generations (doc §35, Invariant 4).
   */
  readonly generationId: string
  /**
   * Embed a batch of texts into L2-normalized vectors. Batches are bounded by
   * BOTH max items and estimated tokens (token-aware splitter upstream).
   */
  embed(texts: string[], opts?: EmbedOptions): Promise<number[][]>
}

// ── Error classification (doc §26) ──────────────────────────────────────────

export type EmbeddingErrorKind =
  | 'auth'      // 401/403 — config problem, do not blind-retry
  | 'request'   // 400     — our bug; fallback must not hide it silently
  | 'quota'     // 429     — cooldown + failover
  | 'timeout'   // transient — retry policy applies
  | 'provider'  // 5xx     — provider-side failure
  | 'unknown'

export class EmbeddingError extends Error {
  readonly kind: EmbeddingErrorKind
  constructor(kind: EmbeddingErrorKind, message: string) {
    super(message)
    this.name = 'EmbeddingError'
    this.kind = kind
  }
}

export function classifyEmbeddingError(err: unknown): EmbeddingError {
  if (err instanceof EmbeddingError) return err
  const msg = err instanceof Error ? err.message.toLowerCase() : String(err).toLowerCase()
  const status =
    typeof err === 'object' && err !== null && 'status' in err
      ? Number((err as { status?: unknown }).status)
      : NaN

  if (status === 401 || status === 403 || /unauthor|forbidden|api key|invalid[_ ]key/.test(msg))
    return new EmbeddingError('auth', err instanceof Error ? err.message : String(err))
  if (status === 429 || /rate limit|quota/.test(msg))
    return new EmbeddingError('quota', err instanceof Error ? err.message : String(err))
  if (status === 408 || /timeout|timed out|etimedout|aborted|epipe|econnreset|socket hang up/.test(msg))
    return new EmbeddingError('timeout', err instanceof Error ? err.message : String(err))
  if (status === 400 || /bad request|invalid input/.test(msg))
    return new EmbeddingError('request', err instanceof Error ? err.message : String(err))
  if ((status >= 500 && status < 600) || /econnrefused|enotfound|eai_again|network|fetch failed/.test(msg))
    return new EmbeddingError('provider', err instanceof Error ? err.message : String(err))
  return new EmbeddingError('unknown', err instanceof Error ? err.message : String(err))
}
