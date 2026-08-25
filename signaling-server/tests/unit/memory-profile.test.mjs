// Unit tests — memory profile detection & tier policy (adaptive P1).
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const dist = p => require(`../../dist/${p}`)

const ENV_KEYS = ['INSTANCE_MEMORY_MB', 'RAG_ALLOW_LOCAL_TINY', 'RAG_DISABLE_LOCAL']

function freshProfile(envPatch = {}, deps = {}) {
  for (const k of ENV_KEYS) delete process.env[k]
  Object.assign(process.env, envPatch)
  // CONFIG freezes tier-policy booleans at import — bust caches so the
  // freshly-required module tree observes envPatch.
  for (const m of ['config.js', 'rag/memory-profile.js']) {
    delete require.cache[require.resolve(`../../dist/${m}`)]
  }
  return dist('rag/memory-profile.js')
}

describe('detectMemoryProfile', () => {
  beforeEach(() => {
    process.env.RAG_ALLOW_LOCAL_TINY = undefined
    process.env.RAG_DISABLE_LOCAL = undefined
  })
  afterEach(() => {
    for (const k of ENV_KEYS) delete process.env[k]
    const m = freshProfile()
    m.__resetMemoryProfileForTests()
  })

  it('INSTANCE_MEMORY_MB override wins and classifies tiers', () => {
    const mod = freshProfile({ INSTANCE_MEMORY_MB: '512' })
    let mp = mod.detectMemoryProfile({ cgroupV2: () => 16384 })
    assert.equal(mp.tier, 'tiny')
    assert.equal(mp.limitMb, 512)
    assert.equal(mp.source, 'env')

    mod.__resetMemoryProfileForTests()
    process.env.INSTANCE_MEMORY_MB = '4096'
    mp = mod.detectMemoryProfile()
    assert.equal(mp.tier, 'large')
  })

  it('cgroup v2 limit drives tier; ceiling stays under host cap on tiny', () => {
    const mp = freshProfile().detectMemoryProfile({ cgroupV2: () => 512 })
    assert.equal(mp.tier, 'tiny')
    assert.ok(mp.workloadCeilingMb <= 480, `ceiling ${mp.workloadCeilingMb} must be ≤480`)
    assert.ok(mp.workloadCeilingMb >= 300, 'ceiling must leave usable room')
  })

  it('cgroup v2 "max" falls through to v1', () => {
    const mp = freshProfile().detectMemoryProfile({
      cgroupV2: () => null,
      cgroupV1: () => 1024,
    })
    assert.equal(mp.tier, 'standard')
    assert.equal(mp.source, 'cgroup-v1')
  })

  it('no cgroups → sanity-capped host RAM (never trusts huge hosts)', () => {
    const mp = freshProfile().detectMemoryProfile({ totalMemMb: () => 65_536 })
    assert.ok(mp.limitMb <= 4096)
    assert.equal(mp.source, 'host-totalmem')
  })

  it('TINY forbids local embedder by default (the ≤480MB guarantee)', () => {
    const mp = freshProfile().detectMemoryProfile({ cgroupV2: () => 512 })
    assert.equal(mp.localEmbedderAllowed, false)
  })

  it('RAG_ALLOW_LOCAL_TINY=true opts in deliberately', () => {
    const mp = freshProfile({ RAG_ALLOW_LOCAL_TINY: 'true' }).detectMemoryProfile({
      cgroupV2: () => 512,
    })
    assert.equal(mp.localEmbedderAllowed, true)
  })

  it('STANDARD/LARGE permit local embedder', () => {
    const mp = freshProfile().detectMemoryProfile({ cgroupV2: () => 2048 })
    assert.equal(mp.tier, 'standard')
    assert.equal(mp.localEmbedderAllowed, true)
  })

  it('RAG_DISABLE_LOCAL overrides everything (APIs only)', () => {
    const mp = freshProfile({ RAG_DISABLE_LOCAL: 'true', INSTANCE_MEMORY_MB: '8192' })
      .detectMemoryProfile()
    assert.equal(mp.localEmbedderAllowed, false)
  })

  it('memoized until explicitly reset', () => {
    const mod = freshProfile()
    const a = mod.detectMemoryProfile({ cgroupV2: () => 512 })
    const b = mod.detectMemoryProfile({ cgroupV2: () => 8192 }) // ignored
    assert.equal(a, b)
    mod.__resetMemoryProfileForTests()
    const c = mod.detectMemoryProfile({ cgroupV2: () => 8192 })
    assert.equal(c.tier, 'large')
  })

  it('orchestrator excludes local provider when profile forbids it', async () => {
    process.env.INSTANCE_MEMORY_MB = '512'
    delete process.env.RAG_ALLOW_LOCAL_TINY
    for (const m of ['config.js', 'rag/memory-profile.js', 'rag/embedding/orchestrator.js']) {
      delete require.cache[require.resolve(`../../dist/${m}`)]
    }
    const { createOrchestrator } = dist('rag/embedding/orchestrator.js')
    const localOnly = [{
      id: 'local-bge',
      generationId: 'local:x:384:cosine',
      embed: async () => [[1, 0]],
    }]
    const o = createOrchestrator(localOnly, { threshold: 1, cooldownMs: 10 })
    assert.deepEqual(o.health(), [], 'local filtered out on TINY default')
    await assert.rejects(() => o.embed(['a']), err => {
      // Cross-instance safe: match on name/message, not class identity.
      return err?.name === 'EmbeddingUnavailableError' ||
        /unavailable|no embedding provider/i.test(err?.message ?? '')
    })
  })
})
