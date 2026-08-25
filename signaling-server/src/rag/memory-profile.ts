import os from 'os'
import fs from 'fs'
import { CONFIG } from '../config'
import logger from '../logger'

// ── Memory profile (adaptive architecture §12/§15) ──────────────────────────
// Detects the memory this process is actually ALLOWED to use and maps it to a
// capability tier. The tier drives every adaptive default: workload ceilings,
// direct-stuff budget context, local-model eligibility.
//
// Detection order (first authoritative value wins):
//   1. INSTANCE_MEMORY_MB env override (operator knows best)
//   2. cgroup v2  /sys/fs/cgroup/memory.max        ("max" ⇒ not a limit)
//   3. cgroup v1  /sys/fs/cgroup/memory/memory.limit_in_bytes
//   4. host RAM via os.totalmem() — UNTRUSTED inside containers (reports HOST
//      RAM, e.g. 64GB on a 512MB Render container), so this fallback is
//      sanity-capped and warned about.
//
// Guarantee posture: fail-safe. Any read error ⇒ assume TINY (most
// conservative tier that can never exceed a small host).

export type MemoryTier = 'tiny' | 'standard' | 'large'

export interface MemoryProfile {
  tier: MemoryTier
  /** Detected/declared memory available to this process, MB. */
  limitMb: number
  /** TOTAL-process workload ceiling (MB). Jobs pause before crossing it;
   *  includes headroom for Node baseline + native allocators (review §5/§8). */
  workloadCeilingMb: number
  /** Whether loading the local ONNX embedder is permitted on this host. */
  localEmbedderAllowed: boolean
  source: 'env' | 'cgroup-v2' | 'cgroup-v1' | 'host-totalmem' | 'fallback'
}

const MB = 1024 * 1024
/** Cap applied when only untrustworthy host-totalmem is available (§8). */
export const SANITY_MAX_MB = 4096

function classify(limitMb: number): MemoryTier {
  if (limitMb < 768) return 'tiny'
  if (limitMb <= 2048) return 'standard' // 2GB instances are STANDARD
  return 'large'
}

/** Total-process ceiling: limit − fixed headroom for baseline/native/spikes. */
function workloadCeiling(tier: MemoryTier, limitMb: number): number {
  if (tier === 'tiny') return Math.min(CONFIG.EMBED_MAX_RSS_MB, limitMb - 96)
  if (tier === 'standard') return Math.min(1200, limitMb - 256)
  return Math.min(3072, limitMb - 512)
}

interface DetectDeps {
  cgroupV2?: () => number | null
  cgroupV1?: () => number | null
  totalMemMb?: () => number
}

let cached: MemoryProfile | null = null

/**
 * @param deps injection seam for unit tests; production uses real readers.
 */
export function detectMemoryProfile(deps: DetectDeps = {}): MemoryProfile {
  const readV2 = deps.cgroupV2 ?? (() => {
    try {
      const raw = fs.readFileSync('/sys/fs/cgroup/memory.max', 'utf8').trim()
      if (!raw || raw === 'max') return null
      const bytes = Number(raw)
      return Number.isFinite(bytes) && bytes > 0 ? Math.round(bytes / MB) : null
    } catch {
      return null
    }
  })
  const readV1 = deps.cgroupV1 ?? (() => {
    try {
      const bytes = Number(fs.readFileSync('/sys/fs/cgroup/memory/memory.limit_in_bytes', 'utf8').trim())
      // v1 reports ~9.2e18 (PAGE_COUNTER_MAX) when unlimited.
      return Number.isFinite(bytes) && bytes > 0 && bytes < Number.MAX_SAFE_INTEGER / 8
        ? Math.round(bytes / MB)
        : null
    } catch {
      return null
    }
  })
  const readTotal = deps.totalMemMb ?? (() => Math.round(os.totalmem() / MB))

  const build = (limitMb: number, source: MemoryProfile['source']): MemoryProfile => {
    const tier = classify(limitMb)
    // Local embedder can be disabled by policy regardless of tier.
    const localEmbedderAllowed =
      !CONFIG.RAG_DISABLE_LOCAL && (tier !== 'tiny' || CONFIG.RAG_ALLOW_LOCAL_TINY)
    return {
      tier,
      limitMb,
      workloadCeilingMb: workloadCeiling(tier, limitMb),
      localEmbedderAllowed,
      source,
    }
  }

  if (!cached) {
    try {
      const envOverride = Number(process.env.INSTANCE_MEMORY_MB ?? '')
      if (Number.isFinite(envOverride) && envOverride > 0) {
        cached = build(Math.round(envOverride), 'env')
      } else {
        const v2 = readV2()
        const v1 = v2 === null ? readV1() : null
        if (v2 !== null || v1 !== null) {
          cached = build((v2 ?? v1) as number, v2 !== null ? 'cgroup-v2' : 'cgroup-v1')
        } else {
          const hostMb = Math.min(readTotal(), SANITY_MAX_MB)
          logger.warn(
            { hostMb },
            '[rag] no cgroup memory limit found — sanity-capped host RAM in use; set INSTANCE_MEMORY_MB to override',
          )
          cached = build(hostMb, 'host-totalmem')
        }
      }
    } catch {
      logger.warn('[rag] memory detection failed — assuming TINY (512MB)')
      cached = build(512, 'fallback')
    }
    logger.info(
      {
        tier: cached.tier,
        limitMb: cached.limitMb,
        ceilingMb: cached.workloadCeilingMb,
        localAllowed: cached.localEmbedderAllowed,
        source: cached.source,
      },
      '[rag] host memory profile detected',
    )
  }
  return cached
}

/** Test seam: drop the memoized profile (call after env/config changes). */
export function __resetMemoryProfileForTests(): void {
  cached = null
}
