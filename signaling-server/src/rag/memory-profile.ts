import os from 'os'
import fs from 'fs'
import { CONFIG } from '../config'
import logger from '../logger'

// ── Memory profile (adaptive architecture §12/§15) ──────────────────────────
// Detects the memory this process is actually ALLOWED to use and maps it to a
// capability tier. The tier drives every adaptive default: RSS ceilings,
// direct-stuff budget, local-model eligibility, reranker availability.
//
// Detection order (first authoritative value wins):
//   1. INSTANCE_MEMORY_MB env override (operator knows best)
//   2. cgroup v2  /sys/fs/cgroup/memory.max        ("max" ⇒ not a limit)
//   3. cgroup v1  /sys/fs/cgroup/memory/memory.limit_in_bytes
//   4. host total RAM via os.totalmem() — UNTRUSTED inside containers (reports
//      the HOST's RAM, e.g. 64GB on a 512MB Render container), so when we fall
//      through to here we cap the reading at SANITY_MAX_MB and warn.
//
// Guarantee posture: detection is fail-safe. If anything throws, we assume
// TINY — the most conservative tier.

export type MemoryTier = 'tiny' | 'standard' | 'large'

export interface MemoryProfile {
  tier: MemoryTier
  /** Detected/declared memory available to this process, in MB. */
  limitMb: number
  /** Total-process workload ceiling in MB — jobs pause before exceeding it.
   *  Derived with headroom for Node baseline + native allocators + spikes. */
  workloadCeilingMb: number
  /** Whether loading the local ONNX embedder is permitted on this tier. */
  localEmbedderAllowed: boolean
  source: 'env' | 'cgroup-v2' | 'cgroup-v1' | 'host-totalmem' | 'fallback'
}

const MB = 1024 * 1024
/** Cap for untrustworthy host-totalmem readings (§8 of review). */
const SANITY_MAX_MB = 4096

function readCgroupV2(): number | null {
  try {
    const raw = fs.readFileSync('/sys/fs/cgroup/memory.max', 'utf8').trim()
    if (!raw || raw === 'max') return null
    const bytes = Number(raw)
    if (!Number.isFinite(bytes) || bytes <= 0) return null
    return Math.round(bytes / MB)
  } catch {
    return null
  }
}

function readCgroupV1(): number | null {
  try {
    const raw = fs
      .readFileSync('/sys/fs/cgroup/memory/memory.limit_in_bytes', 'utf8')
      .trim()
    const bytes = Number(raw)
    // v1 reports ~9.2e18 (PAGE_COUNTER_MAX) when unlimited.
    if (!Number.isFinite(bytes) || bytes <= 0 || bytes > Number.MAX_SAFE_INTEGER / 8) return null
    return Math.round(bytes / MB)
  } catch {
    return null
  }
}

function classify(limitMb: number): MemoryTier {
  if (limitMb < 768) return 'tiny'
  if (limitMb < 2048) return 'standard'
  return 'large'
}

/**
 * Total-process ceiling = limit minus fixed headroom that must stay free for
 * the event loop, native allocators, transient request buffers and the kind
 * of allocation spikes that live OUTSIDE V8 accounting (review §5/§6).
 * Never intentionally allocate a stage whose projection crosses this line;
 * crossing it triggers PipelinePausedError instead of an OOM kill.
 */
function workloadCeiling(tier: MemoryTier, limitMb: number): number {
  if (tier === 'tiny') return Math.min(CONFIG.EMBED_MAX_RSS_MB, limitMb - 96)
  if (tier === 'standard') return Math.min(1200, limitMb - 256)
  return Math.min(3072, limitMb - 512) // large hosts: generous but still bounded
}

let cached: MemoryProfile | null = null

export function detectMemoryProfile(): MemoryProfile {
  if (cached) return cached
  let profile: MemoryProfile
  try {
    const envOverride = Number(process.env.INSTANCE_MEMORY_MB ?? '')
    if (Number.isFinite(envOverride) && envOverride > 0) {
      const limitMb = Math.round(envOverride)
      const tier = classify(limitMb)
      profile = { tier, limitMb, workloadCeilingMb: workloadCeiling(tier, limitMb), localEmbedderAllowed: true, source: 'env' }
    } else {
      const v2 = readCgroupV2()
      const v1 = v2 === null ? readCgroupV1() : null
      if (v2 !== null || v1 !== null) {
        const limitMb = (v2 ?? v1) as number
        const tier = classify(limitMb)
        profile = {
          tier,
          limitMb,
          workloadCeilingMb: workloadCeiling(tier, limitMb),
          localEmbedderAllowed:
            tier !== 'tiny' ? true : CONFIG.RAG_ALLOW_LOCAL_TINY,
          source: v2 !== null ? 'cgroup-v2' : 'cgroup-v1',
        }
      } else {
        // No cgroup files readable — host RAM, sanity-capped.
        const hostMb = Math.round(os.totalmem() / MB)
        const limitMb = Math.min(hostMb, SANITY_MAX_MB)
        const tier = classify(limitMb)
        logger.warn(
          { hostMb },
          '[rag] no cgroup memory limit found — using sanity-capped host RAM; set INSTANCE_MEMORY_MB to override',
        )
        profile = {
          tier,
          limitMb,
          workloadCeilingMb: workloadCeiling(tier, limitMb),
          localEmbedderAllowed: tier !== 'tiny' ? true : CONFIG.RAG_ALLOW_LOCAL_TINY,
          source: 'host-totalmem',
        }
      }
    }
  } catch {
    profile = {
      tier: 'tiny',
      limitMb: 512,
      workloadCeilingMb: Math.min(CONFIG.EMBED_MAX_RSS_MB, 512 - 96),
      localEmbedderAllowed: CONFIG.RAG_ALLOW_LOCAL_TINY,
      source: 'fallback',
    }
  }

  // Local embedder can be disabled by policy regardless of tier.
  if (CONFIG.RAG_DISABLE_LOCAL) profile.localEmbedderAllowed = false

  cached = profile
  logger.info(
    {
      tier: profile.tier,
      limitMb: profile.limitMb,
      ceilingMb: profile.workloadCeilingMb,
      localAllowed: profile.localEmbedderAllowed,
      source: profile.source,
    },
    '[rag] host memory profile detected',
  )
  return profile
}

/** Test seam: reset memoized profile (env/config changes require re-detect). */
export function __resetMemoryProfileForTests(): void {
  cached = null
}
