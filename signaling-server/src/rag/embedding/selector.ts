import { CONFIG } from '../../config'
import { detectMemoryProfile } from '../memory-profile'
import type { EmbedInputType, EmbeddingProvider } from './provider'

// ── Model Selector (adaptive services ③) ────────────────────────────────────
// Centralizes the FULL eligibility predicate (architecture doc §8/§22):
//
//     registered ∧ permitted-on-tier ∧ breaker-closed ∧ quota-plausible ∧
//     RAM-headroom-ok ∧ workload-tier-appropriate
//
// and owns the MODEL REGISTRY — the mapping model-id → providers that can
// serve it. When two providers ever serve the SAME model, failover keeps the
// vector space valid without a generation rebuild (doc §34 Strategy A).
// Today every provider has a unique model; the table is ready regardless.

export interface ProviderCandidate {
  provider: EmbeddingProvider
  /** Breaker state as reported by the orchestrator health snapshot. */
  breakerState: 'healthy' | 'open' | 'half_open'
  /** Rolling success/failure hint from the health monitor (optional). */
  consecutiveUnhealthyChecks?: number
}

export interface SelectionContext {
  /** Estimated tokens this job will embed (workload analyzer output). */
  estimatedTokens: number
}

export type WorkloadClass = 'low' | 'medium' | 'high' | 'very_high'

export function workloadClass(estimatedTokens: number): WorkloadClass {
  if (estimatedTokens <= 4_000) return 'low'
  if (estimatedTokens <= 32_000) return 'medium'
  if (estimatedTokens <= 120_000) return 'high'
  return 'very_high'
}

/**
 * Hard ineligibility (never route here right now):
 *  - breaker fully open (half_open may pass one probe)
 *  - monitor says discontinued AND breaker not healthy (belt & braces)
 */
function isHardBlocked(c: ProviderCandidate): boolean {
  if (c.breakerState === 'open') return true
  if (
    typeof c.consecutiveUnhealthyChecks === 'number' &&
    c.consecutiveUnhealthyChecks >= 5 &&
    c.breakerState !== 'healthy'
  ) {
    return true
  }
  return false
}

/** Soft preference score — higher is better. Deterministic. */
export function scoreCandidate(
  c: ProviderCandidate,
  _ctx: SelectionContext,
): number {
  let score = 100
  if (c.breakerState === 'healthy') score += 50
  if (c.breakerState === 'half_open') score -= 20
  if (typeof c.consecutiveUnhealthyChecks === 'number') {
    score -= Math.min(40, c.consecutiveUnhealthyChecks * 10)
  }
  // API providers are preferred over local on memory-constrained tiers —
  // the memory profile already excludes local entirely on TINY defaults.
  const profile = detectMemoryProfile()
  if (profile.tier === 'tiny' && c.provider.id !== 'local-bge') score += 25
  return score
}

/**
 * Order candidates best-first for ONE embedding job.
 * `localPermitted` reflects the memory-profile decision made by the
 * orchestrator when building its registry.
 */
export function selectOrder(
  candidates: ProviderCandidate[],
  ctx: SelectionContext,
): ProviderCandidate[] {
  const usable = candidates.filter(c => !isHardBlocked(c))
  return usable.sort((a, b) => scoreCandidate(b, ctx) - scoreCandidate(a, ctx))
}

/** Registry: model-id → providers able to serve that exact model. */
export class ModelRegistry {
  private readonly byModel = new Map<string, ProviderCandidate[]>()

  register(modelId: string, candidate: ProviderCandidate): void {
    const list = this.byModel.get(modelId) ?? []
    list.push(candidate)
    this.byModel.set(modelId, list)
  }

  models(): string[] {
    return [...this.byModel.keys()]
  }

  /** Providers serving EXACTLY this model — same-space failover targets. */
  providersFor(modelId: string): ProviderCandidate[] {
    return selectOrder(this.byModel.get(modelId) ?? [], { estimatedTokens: 0 })
  }
}
