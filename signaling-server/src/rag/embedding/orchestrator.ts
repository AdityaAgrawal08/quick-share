import logger from '../../logger'
import { CONFIG } from '../../config'
import type { EmbeddingProvider } from './provider'
import { classifyEmbeddingError, EmbeddingError } from './provider'
import { CircuitBreaker } from './circuit-breaker'
import { getLocalProvider, ACTIVE_GENERATION } from './local-provider'
import { detectMemoryProfile } from '../memory-profile'
import type { EmbedOptions, EmbedInputType } from './provider'

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
  embed(texts: string[], opts?: EmbedOptions): Promise<EmbedResult>
  embedForGeneration(text: string, generationId: string): Promise<number[]>
  health(): { id: string; state: string }[]
  generations(): string[]
}

interface ProviderEntry {
  provider: EmbeddingProvider
  breaker: CircuitBreaker
}

export function createOrchestrator(
  providers: EmbeddingProvider[],
  deps: OrchestratorDeps = {},
  opts: { allowEmpty?: boolean } = {},
): Orchestrator {
  const threshold = deps.threshold ?? CONFIG.BREAKER_THRESHOLD
  const cooldownMs = deps.cooldownMs ?? CONFIG.BREAKER_COOLDOWN_MS
  // Eligibility predicate (review §8): registered ∧ compatible ∧ permitted.
  // The memory profile decides whether the LOCAL provider may exist on this
  // host at all — on TINY tiers without explicit opt-in it is excluded so the
  // ONNX model can never be allocated, guaranteeing the ≤480MB posture.
  const profile = detectMemoryProfile()
  const eligibleProviders = providers.filter(p => {
    if (p.id === 'local-bge' && !profile.localEmbedderAllowed) return false
    return true
  })
  const entries: ProviderEntry[] = eligibleProviders.map(provider => ({
    provider,
    breaker: new CircuitBreaker(provider.id, threshold, cooldownMs),
  }))
  // An EMPTY registry is legal (TINY host without local permission and without
  // API keys): the server boots fine for DIRECT-mode sessions; any embedding
  // request fails closed via EmbeddingUnavailableError → jobs pause cleanly.
  // Zero providers is ONLY legal for the env-built registry (keys absent on
  // a TINY host): the server boots fine for DIRECT-mode sessions and any
  // embedding request fails closed via EmbeddingUnavailableError.
  if (providers.length === 0 && !opts.allowEmpty) {
    throw new Error('createOrchestrator requires at least one provider')
  }

  return {
    /**
     * Embed one batch with failover. Always rejects with EmbeddingError (or
     * EmbeddingUnavailableError when every circuit is open) so callers can
     * branch on error classes instead of strings.
     */
    async embed(texts: string[], opts: EmbedOptions = {}): Promise<EmbedResult> {
      let lastErr: EmbeddingError | null = null
      for (const entry of entries) {
        if (!entry.breaker.canPass()) continue
        try {
          const vectors = await entry.provider.embed(texts, opts)
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

    generations() {
      return entries.map(e => e.provider.generationId)
    },

    async embedForGeneration(text: string, generationId: string): Promise<number[]> {
      const entry = entries.find(e => e.provider.generationId === generationId)
      if (!entry) {
        throw new GenerationMismatchError(
          generationId,
          entries[0]?.provider.generationId ?? 'none-permitted',
        )
      }
      if (!entry.breaker.canPass()) {
        // Same generation, temporarily unhealthy — the job that would serve
        // this query cannot proceed; surface as unavailable (retryable).
        throw new EmbeddingUnavailableError(
          `generation ${generationId} provider circuit open`,
        )
      }
      try {
        const inputType: EmbedInputType = 'query'
        const [vector] = await entry.provider.embed([text], { inputType })
        if (!Array.isArray(vector) || vector.length === 0 || vector.some(n => !Number.isFinite(n))) {
          throw new EmbeddingError('provider', 'query embedding malformed')
        }
        entry.breaker.recordSuccess()
        return vector
      } catch (err) {
        const classified = classifyEmbeddingError(err)
        entry.breaker.recordFailure()
        logger.warn(
          { provider: entry.provider.id, kind: classified.kind, err: classified.message },
          '[rag] query embedding failure',
        )
        throw classified
      }
    },
  }
}

/**
 * Build the production registry FROM ENV (review §8 eligibility starts at
 * configuration): [COHERE_API_KEY]→cohere, [VOYAGE_API_KEY]→voyage, then the
 * local BGE fallback — reordered by RAG_PROVIDER_ORDER. An empty external set
 * + forbidden local ⇒ empty registry ⇒ embedding jobs pause cleanly while
 * DIRECT-mode sessions keep working.
 */
function buildRegistryFromEnv(): EmbeddingProvider[] {
  const byId: Record<string, EmbeddingProvider> = {}
  if (CONFIG.COHERE_API_KEY) {
    // Lazy-require to keep this module import-light for tests.
    const { CohereProvider } = require('./providers/cohere.js')
    byId.cohere = new CohereProvider(CONFIG.COHERE_API_KEY, fetch)
  }
  if (CONFIG.VOYAGE_API_KEY) {
    const { VoyageProvider } = require('./providers/voyage.js')
    byId.voyage = new VoyageProvider(CONFIG.VOYAGE_API_KEY, fetch)
  }
  byId.local = getLocalProvider()
  return CONFIG.RAG_PROVIDER_ORDER.map(id => byId[id]).filter(Boolean)
}

let defaultOrchestrator: Orchestrator | null = null
function getDefaultOrchestrator(): Orchestrator {
  if (!defaultOrchestrator) defaultOrchestrator = createOrchestrator(buildRegistryFromEnv(), undefined, { allowEmpty: true })
  return defaultOrchestrator
}

export const ACTIVE_GENERATION_ID = ACTIVE_GENERATION

/**
 * TEST-ONLY seam: swap the production provider registry (e.g. a deterministic
 * stub) so integration suites never download/load the ONNX model. Never call
 * from server code.
 */
export function __setProvidersForTests(providers: EmbeddingProvider[], deps?: OrchestratorDeps): void {
  defaultOrchestrator = providers.length
    ? createOrchestrator(providers, deps)
    : createOrchestrator(buildRegistryFromEnv(), deps, { allowEmpty: true })
}

/**
 * TEST-ONLY: force a truly EMPTY registry (Render-free posture) regardless of
 * env/config — avoids module-instance ambiguity when suites cache requires.
 */
export function __setEmptyRegistryForTests(deps?: OrchestratorDeps): void {
  defaultOrchestrator = createOrchestrator([], deps ?? {}, { allowEmpty: true })
}

export function embedWithFailover(texts: string[], opts: EmbedOptions = {}): Promise<EmbedResult> {
  return getDefaultOrchestrator().embed(texts, opts)
}

export function providerHealth(): { id: string; state: string }[] {
  return getDefaultOrchestrator().health()
}

/** Generations this process can currently serve queries/indexing for. */
export function listRegisteredGenerations(): string[] {
  return getDefaultOrchestrator().generations()
}

/**
 * Providers still able to take work RIGHT NOW (breaker closed or half-open
 * probe available). When this is 0 mid-job, callers may degrade to BM25
 * instead of pausing — the Render-free never-fail rule.
 */
export function usableProviderCount(): number {
  const o = getDefaultOrchestrator()
  // health() reports breaker states per entry in registry order.
  return o.health().filter(h => h.state !== 'open').length
}

export interface ProviderSnapshot {
  id: string
  state: string
  generationId?: string
}

export function providerSnapshots(): ProviderSnapshot[] {
  const o = getDefaultOrchestrator()
  const gens = o.generations()
  return o.health().map((h, i) => ({ ...h, generationId: gens[i] }))
}

/**
 * Whether ANY embedding provider is permitted+configured on this host.
 * When false, vector indexing is impossible — callers must fall back to
 * BM25-only mode instead of pausing jobs (Render-free guarantee).
 */
export function embeddingPathAvailable(): boolean {
  return getDefaultOrchestrator().generations().length > 0
}

/** Embed a single query via the active provider chain. */

/** Embed a single query via the active provider chain. */
export async function embedQuery(text: string): Promise<number[]> {
  const { vectors } = await embedWithFailover([text])
  return vectors[0]
}

/**
 * Embed a query with the provider of a SPECIFIC generation (doc §54 Option 1):
 * retrieval must ask questions in the same vector space as the index it
 * searches. Unknown generation → GenerationMismatchError, which callers map
 * to a transparent rebuild onto the active generation.
 */
export function embedQueryForGeneration(
  text: string,
  expectedGeneration: string,
): Promise<number[]> {
  return getDefaultOrchestrator().embedForGeneration(text, expectedGeneration)
}
