import logger from '../../logger'
import { CONFIG } from '../../config'
import type { EmbeddingProvider } from './provider'
import { classifyEmbeddingError, EmbeddingError } from './provider'
import { CircuitBreaker } from './circuit-breaker'
import { getLocalProvider, ACTIVE_GENERATION } from './local-provider'

// ── Embedding orchestrator (architecture doc §19/§20/§25) ───────────────────
// Ordered provider list; pick the highest-priority provider whose circuit
// allows a pass. Real production requests are the definitive health signal —
// success/failure feeds the breaker. No synthetic probe requests are ever
// spent just to "check availability" (doc §21).
//
// The registry is built via createOrchestrator() so tests can inject fake
// providers; production uses the local BGE fallback singleton below.

export class EmbeddingUnavailableError extends Error {
  constructor(message = 'all embedding providers unavailable') {
    super(message)
    this.name = 'EmbeddingUnavailableError'
  }
}

/** Thrown when stored vectors come from a different embedding space than the
 *  active generation — retrieval must never silently mix them (doc §35). */
export class GenerationMismatchError extends Error {
  constructor(public readonly storedGen: string, public readonly activeGen: string) {
    super(`vector generation mismatch: stored=${storedGen} active=${activeGen}`)
    this.name = 'GenerationMismatchError'
  }
}

export interface OrchestratorDeps {
  threshold?: number
  cooldownMs?: number
}

export interface EmbedResult {
  vectors: number[][]
  generationId: string
}

export interface Orchestrator {
  embed(texts: string[]): Promise<EmbedResult>
  health(): { id: string; state: string }[]
}

interface ProviderEntry {
  provider: EmbeddingProvider
  breaker: CircuitBreaker
}

export function createOrchestrator(
  providers: EmbeddingProvider[],
  deps: OrchestratorDeps = {},
): Orchestrator {
  const threshold = deps.threshold ?? CONFIG.BREAKER_THRESHOLD
  const cooldownMs = deps.cooldownMs ?? CONFIG.BREAKER_COOLDOWN_MS
  const entries: ProviderEntry[] = providers.map(provider => ({
    provider,
    breaker: new CircuitBreaker(provider.id, threshold, cooldownMs),
  }))
  if (entries.length === 0) throw new Error('createOrchestrator requires at least one provider')

  return {
    /**
     * Embed one batch with failover. Always rejects with EmbeddingError (or
     * EmbeddingUnavailableError when every circuit is open) so callers can
     * branch on error classes instead of strings.
     */
    async embed(texts: string[]): Promise<EmbedResult> {
      let lastErr: EmbeddingError | null = null
      for (const entry of entries) {
        if (!entry.breaker.canPass()) continue
        try {
          const vectors = await entry.provider.embed(texts)
          // Batch accounting (doc §43.2): partial/short responses are
          // failures, never silently "completed".
          if (!Array.isArray(vectors) || vectors.length !== texts.length) {
            throw new EmbeddingError(
              'provider',
              `batch accounting mismatch: requested ${texts.length}, returned ${Array.isArray(vectors) ? vectors.length : 'non-array'}`,
            )
          }
          const bad = vectors.findIndex(
            v => !Array.isArray(v) || v.length === 0 || v.some(n => !Number.isFinite(n)),
          )
          if (bad >= 0) {
            throw new EmbeddingError('provider', `malformed vector at index ${bad}`)
          }
          entry.breaker.recordSuccess()
          return { vectors, generationId: entry.provider.generationId }
        } catch (err) {
          lastErr = classifyEmbeddingError(err)
          entry.breaker.recordFailure()
          logger.warn(
            { provider: entry.provider.id, kind: lastErr.kind, err: lastErr.message },
            '[rag] embedding provider failure',
          )
          // 'auth'/'request' are configuration/code problems: retrying more
          // batches on the same provider is pointless, but with a single
          // provider we simply fall through to "unavailable".
        }
      }
      throw lastErr ?? new EmbeddingUnavailableError()
    },

    health() {
      return entries.map(e => ({ id: e.provider.id, state: e.breaker.state() }))
    },
  }
}

/** Production singleton — local BGE is today's only (guaranteed) provider. */
let defaultOrchestrator = createOrchestrator([getLocalProvider()])

export const ACTIVE_GENERATION_ID = ACTIVE_GENERATION

/**
 * TEST-ONLY seam: swap the production provider registry (e.g. a deterministic
 * stub) so integration suites never download/load the ONNX model. Never call
 * from server code.
 */
export function __setProvidersForTests(providers: EmbeddingProvider[], deps?: OrchestratorDeps): void {
  defaultOrchestrator = createOrchestrator(providers, deps)
}

export function embedWithFailover(texts: string[]): Promise<EmbedResult> {
  return defaultOrchestrator.embed(texts)
}

export function providerHealth(): { id: string; state: string }[] {
  return defaultOrchestrator.health()
}

/** Embed a single query via the active provider chain. */
export async function embedQuery(text: string): Promise<number[]> {
  const { vectors } = await embedWithFailover([text])
  return vectors[0]
}
