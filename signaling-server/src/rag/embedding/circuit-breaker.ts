// ── Circuit breaker (architecture doc §27) ──────────────────────────────────
// HEALTHY → OPEN after N consecutive failures → HALF_OPEN after cooldown →
// one probe decides. Prevents burning quota/time on a provider already known
// to be failing. Pure state machine, provider-agnostic.

export type BreakerState = 'healthy' | 'open' | 'half_open'

export class CircuitBreaker {
  private failures = 0
  private openedAt = 0
  private probing = false

  constructor(private readonly label: string,
    private readonly threshold: number,
    private readonly cooldownMs: number,
  ) {}

  state(): BreakerState {
    if (this.failures < this.threshold) return 'healthy'
    if (Date.now() - this.openedAt >= this.cooldownMs) return 'half_open'
    return 'open'
  }

  /** Whether a request may proceed right now. Half-open admits one probe. */
  canPass(): boolean {
    const s = this.state()
    if (s === 'healthy') return true
    if (s === 'open') return false
    // half_open: single probe wins the race; everyone else waits.
    if (this.probing) return false
    this.probing = true
    return true
  }

  recordSuccess(): void {
    this.probing = false
    this.failures = 0
  }

  recordFailure(): void {
    this.probing = false
    this.failures += 1
    if (this.failures >= this.threshold) {
      this.openedAt = Date.now()
    }
  }

  reset(): void {
    this.failures = 0
    this.openedAt = 0
    this.probing = false
  }
}
