// Unit tests — pure logic only. No MongoDB, no model weights, no network.
// Run: npm test   (node --test tests/unit/)
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const dist = p => require(`../../dist/${p}`)

// ── Modules under test ───────────────────────────────────────────────────────
const { CircuitBreaker } = dist('rag/embedding/circuit-breaker.js')
const {
  EmbeddingError,
  classifyEmbeddingError,
} = dist('rag/embedding/provider.js')
const {
  createOrchestrator,
  EmbeddingUnavailableError,
} = dist('rag/embedding/orchestrator.js')
const { planCorpus } = dist('rag/analyzer.js')
const { corpusFingerprint } = dist('rag/pipeline.js')
const { cosine, reciprocalFusion } = dist('rag/retriever.js')
const { chunkPages } = dist('rag/chunker.js')

// ── Deterministic fake providers ─────────────────────────────────────────────
function fakeProvider(id, generationId, opts = {}) {
  let calls = 0
  return {
    id,
    generationId,
    get calls() { return calls },
    async embed(texts) {
      calls++
      if (opts.failWhen && opts.failWhen(texts, calls)) throw opts.error ?? new Error('boom')
      if (opts.raw) return opts.raw(texts)
      return texts.map((t, i) => opts.vectors?.(t, i) ?? [1, 0, 0, 0])
    },
  }
}

describe('CircuitBreaker', () => {
  it('starts healthy and admits requests below threshold', () => {
    const b = new CircuitBreaker('t', 3, 60_000)
    assert.equal(b.state(), 'healthy')
    for (let i = 0; i < 2; i++) {
      assert.ok(b.canPass())
      b.recordFailure()
    }
    assert.equal(b.state(), 'healthy') // threshold-1 failures still healthy
  })

  it('opens at threshold and rejects while cooling down', () => {
    const b = new CircuitBreaker('t', 3, 60_000)
    for (let i = 0; i < 3; i++) { b.canPass(); b.recordFailure() }
    assert.equal(b.state(), 'open')
    assert.equal(b.canPass(), false)
    assert.equal(b.canPass(), false) // stays closed during cooldown
  })

  it('half_open admits exactly ONE probe; success closes, failure reopens', async () => {
    const b = new CircuitBreaker('t', 2, 20)
    b.canPass(); b.recordFailure(); b.canPass(); b.recordFailure()
    assert.equal(b.state(), 'open')
    await new Promise(r => setTimeout(r, 30))
    assert.equal(b.state(), 'half_open')
    assert.equal(b.canPass(), true)
    assert.equal(b.canPass(), false) // concurrent probes blocked
    b.recordSuccess()
    assert.equal(b.state(), 'healthy')

    // reopen cycle via half-open failure
    b.canPass(); b.recordFailure(); b.canPass(); b.recordFailure()
    await new Promise(r => setTimeout(r, 30))
    assert.ok(b.canPass())
    b.recordFailure()
    assert.equal(b.state(), 'open')
  })

  it('reset() returns to pristine healthy state', () => {
    const b = new CircuitBreaker('t', 1, 60_000)
    b.canPass(); b.recordFailure()
    assert.equal(b.state(), 'open')
    b.reset()
    assert.equal(b.state(), 'healthy')
    assert.equal(b.canPass(), true)
  })
})

describe('classifyEmbeddingError (doc §26)', () => {
  const cases = [
    [{ status: 401, message: 'Unauthorized' }, 'auth'],
    [{ status: 403, message: 'Forbidden' }, 'auth'],
    [{ message: 'invalid api key supplied' }, 'auth'],
    [{ status: 429, message: 'rate limit exceeded' }, 'quota'],
    [{ message: 'monthly quota exhausted' }, 'quota'],
    [{ status: 408, message: 'Request Timeout' }, 'timeout'],
    [{ message: 'socket hang up' }, 'timeout'],
    [{ status: 400, message: 'Bad Request' }, 'request'],
    [{ status: 500, message: 'Internal Server Error' }, 'provider'],
    [{ status: 503, message: 'Service Unavailable' }, 'provider'],
    [{ message: 'fetch failed: ECONNREFUSED' }, 'provider'],
    [{ message: 'something inexplicable' }, 'unknown'],
  ]
  for (const [input, kind] of cases) {
    it(`maps ${JSON.stringify(input.message || input.status)} → ${kind}`, () => {
      const err = new Error(input.message)
      if ('status' in input) err.status = input.status
      assert.equal(classifyEmbeddingError(err).kind, kind)
    })
  }

  it('passes through existing EmbeddingError untouched', () => {
    const original = new EmbeddingError('quota', 'pre-classified')
    assert.equal(classifyEmbeddingError(original), original)
  })
})

describe('planCorpus (adaptive workload selection)', () => {
  const MAX = 48_000
  it('routes tiny corpora to direct stuffing', () => {
    assert.equal(planCorpus(1, 1).mode, 'direct')
    assert.equal(planCorpus(MAX, 80).mode, 'direct')
  })
  it('routes corpora over the cap to vector mode', () => {
    assert.equal(planCorpus(MAX + 1, 81).mode, 'vector')
    assert.equal(planCorpus(10_000_000, 4000).mode, 'vector')
  })
  it('treats zero chars as vector (nothing to stuff)', () => {
    assert.equal(planCorpus(0, 0).mode, 'vector')
  })
  it('reports totals verbatim for stats', () => {
    assert.deepEqual(planCorpus(1234, 12), { mode: 'direct', totalChars: 1234, chunkCount: 12 })
  })
})

describe('corpusFingerprint (resume anchor)', () => {
  const mk = ids => ids.map(gridfsId => ({ gridfsId }))
  it('is stable for identical corpora', () => {
    const s = { files: mk(['a', 'b']), text: 'hello' }
    assert.equal(corpusFingerprint(s), corpusFingerprint({ ...s, files: [...s.files] }))
  })
  it('changes when file set changes', () => {
    assert.notEqual(corpusFingerprint({ files: mk(['a']), text: '' }),
                    corpusFingerprint({ files: mk(['b']), text: '' }))
  })
  it('changes when text length changes', () => {
    assert.notEqual(corpusFingerprint({ files: mk(['a']), text: 'abc' }),
                    corpusFingerprint({ files: mk(['a']), text: 'abcd' }))
  })
  it('survives missing files array (defensive)', () => {
    assert.equal(typeof corpusFingerprint({ text: 'x' }), 'string')
    assert.equal(typeof corpusFingerprint({}), 'string')
  })
})

describe('hybrid ranking math', () => {
  it('cosine: identical≈1, orthogonal=0, opposite≈-1', () => {
    const a = new Float32Array([1, 0])
    const b = new Float32Array([1, 0])
    const c = new Float32Array([0, 1])
    const d = new Float32Array([-1, 0])
    assert.ok(Math.abs(cosine(a, b) - 1) < 1e-9)
    assert.equal(cosine(a, c), 0)
    assert.ok(Math.abs(cosine(a, d) + 1) < 1e-9)
  })

  it('reciprocalFusion merges ranks and dedupes across legs', () => {
    const bm25 = [{ chunkIdx: 7, rank: 9 }, { chunkIdx: 3, rank: 5 }]
    const vec = [{ chunkIdx: 3, rank: 0.98 }, { chunkIdx: 11, rank: 0.9 }]
    const fused = reciprocalFusion([bm25, vec])
    // Chunk 3 appears in both legs → should outrank single-leg hits.
    assert.equal(fused[0].chunkIdx, 3)
    const idxs = fused.map(f => f.chunkIdx)
    assert.deepEqual([...new Set(idxs)].sort((x, y) => x - y), [3, 7, 11].sort((x, y) => x - y))
  })

  it('reciprocalFusion caps output at FUSION_KEEP entries', () => {
    const leg = Array.from({ length: 50 }, (_, i) => ({ chunkIdx: i, rank: 50 - i }))
    assert.ok(reciprocalFusion([leg]).length <= 12)
  })
})

describe('orchestrator (failover, accounting, breakers)', () => {
  it('returns vectors stamped with the serving provider generation', async () => {
    const p = fakeProvider('p1', 'gen-1')
    const o = createOrchestrator([p])
    const res = await o.embed(['hello', 'world'])
    assert.equal(res.generationId, 'gen-1')
    assert.equal(res.vectors.length, 2)
    assert.deepEqual(o.health(), [{ id: 'p1', state: 'healthy' }])
  })

  it('rejects short/partial batches as provider failures (doc §43.2)', async () => {
    const p = fakeProvider('p1', 'g', { raw: () => [[1, 0]] }) // asked for 2, got 1
    const o = createOrchestrator([p], { threshold: 1, cooldownMs: 60_000 })
    await assert.rejects(() => o.embed(['a', 'b']), err => {
      assert.ok(err instanceof EmbeddingError)
      assert.match(err.message, /batch accounting mismatch/)
      assert.equal(err.kind, 'provider')
      return true
    })
    assert.equal(o.health()[0].state, 'open')
  })

  it('rejects malformed vectors (NaN/empty/non-array entries)', async () => {
    const bad = [Number.NaN, 1]
    const p = fakeProvider('p1', 'g', { raw: () => [[...bad]] })
    const o = createOrchestrator([p], { threshold: 10, cooldownMs: 1 })
    await assert.rejects(() => o.embed(['a']), /malformed vector/)
  })

  it('fails over to the next eligible provider in priority order', async () => {
    const primary = fakeProvider('primary', 'g-primary', { failWhen: () => true })
    const secondary = fakeProvider('secondary', 'g-secondary')
    const o = createOrchestrator([primary, secondary], { threshold: 100, cooldownMs: 1 })
    const res = await o.embed(['x'])
    assert.equal(res.generationId, 'g-secondary')
    assert.ok(primary.calls > 0)
  })

  it('throws EmbeddingUnavailableError when every circuit is open', async () => {
    const p = fakeProvider('only', 'g', { failWhen: () => true })
    const o = createOrchestrator([p], { threshold: 1, cooldownMs: 60_000 })
    await assert.rejects(() => o.embed(['a'])) // trips breaker
    await assert.rejects(() => o.embed(['a']), err => {
      assert.ok(err instanceof EmbeddingUnavailableError || err instanceof EmbeddingError)
      return true
    })
    assert.equal(o.health()[0].state, 'open')
    assert.equal(p.calls, 1) // breaker prevented further attempts
  })

  it('half-open cooldown lets a recovered provider back in', async () => {
    let failing = true
    const p = fakeProvider('flaky', 'g', { failWhen: () => failing })
    const o = createOrchestrator([p], { threshold: 1, cooldownMs: 15 })
    await assert.rejects(() => o.embed(['a']))
    await new Promise(r => setTimeout(r, 25))
    failing = false
    const res = await o.embed(['a']) // half-open probe succeeds
    assert.equal(res.generationId, 'g')
    assert.equal(o.health()[0].state, 'healthy')
  })
})

describe('chunker indexing invariant (multi-file safety)', () => {
  it('idx restarts at 0 per chunkPages call — callers MUST apply offsets', () => {
    const pages = [{ page: null, text: 'para one. para two. para three.' }]
    const a = chunkPages('f1.txt', pages)
    const b = chunkPages('f2.txt', pages)
    assert.ok(a.length > 0)
    assert.equal(a[0].idx, 0)
    assert.equal(b[0].idx, 0, 'second file restarts at 0 → offset required')
  })
})
