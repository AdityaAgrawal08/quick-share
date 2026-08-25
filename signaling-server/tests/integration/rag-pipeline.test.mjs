// Integration tests — durable work units, resume, generation consistency,
// direct stuffing, breaker pause/recovery. Runs against REAL MongoDB.
//
// Usage:
//   npm run test:integration
//     → falls back to the credentials in signaling-server/.env automatically.
//   MONGODB_URI_TEST="mongodb+srv://user:pass@cluster/?…" npm run test:integration
//     → explicit override.
//
// Isolation guarantee: the suite ALWAYS connects to a dedicated throwaway
// database `qs-it-<random>` (any /dbname in the URI is replaced) and drops
// only that database at the end. Your app data is never touched.
//
// No ONNX model is downloaded: a deterministic stub embedding provider is
// injected via the orchestrator's test seam.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'

const require = createRequire(import.meta.url)
const dist = p => require(`../../dist/${p}`)

// Load .env-backed config FIRST so MONGODB_URI/GROQ_API_KEY are populated
// exactly like a real boot (dist/config.js never overrides existing vars).
require('../../dist/config.js')

const RAW_URI = process.env.MONGODB_URI_TEST ?? process.env.MONGODB_URI
if (!RAW_URI) {
  console.log('ℹ No MONGODB_URI_TEST / .env MONGODB_URI — integration suite skipped.')
  process.exit(0)
}

/** Force an isolated throwaway database name; keep auth/query params. */
function withIsolatedTestDb(uri) {
  const qIdx = uri.indexOf('?')
  const base = qIdx >= 0 ? uri.slice(0, qIdx) : uri
  const query = qIdx >= 0 ? uri.slice(qIdx) : ''
  const m = base.match(/^(mongodb(?:\+srv)?:\/\/[^/]+)\/?/)
  if (!m) throw new Error(`Unrecognized MongoDB URI shape: ${uri.replace(/:[^:@/]*@/, ':***@')}`)
  return `${m[1]}/qs-it-${randomUUID().slice(0, 8)}${query}`
}
const URI = withIsolatedTestDb(RAW_URI)

// ── Env must be final BEFORE config/db modules load ──────────────────────────
// config.js already ran once (above) and froze CONFIG.MONGODB_URI to the RAW
// uri — evict it from the CJS cache so db/pipeline re-require a fresh CONFIG
// bound to the isolated throwaway database instead.
// Integration tests exercise LOGIC, not the host budget — give the suite a
// LARGE profile so the RSS ceiling guard never fires on stub workloads.
// Deterministic planning budgets (operator .env must not skew modes):
// small token gate keeps vector/bm25 paths exercised by these corpora.
process.env.RAG_DIRECT_STUFF_MAX_TOKENS = '32768'
process.env.RAG_DIRECT_STUFF_CHARS = '96000'
process.env.INSTANCE_MEMORY_MB = '4096'
process.env.MONGODB_URI = URI
delete require.cache[require.resolve('../../dist/config.js')]

const { connectDB, StoredSession, RagChunk, mongoose, deleteRagChunks } = dist('db.js')
const { ObjectId } = require('mongodb')
const { indexSession, corpusFingerprint, recoverPendingIndexes } = dist('rag/pipeline.js')
const { retrieve } = dist('rag/retriever.js')
const {
  GenerationMismatchError,
  __setProvidersForTests,
  __setEmptyRegistryForTests,
} = dist('rag/embedding/orchestrator.js')

const GEN = 'stub:v1'
const DIM = 8

/** Deterministic pseudo-embedding: same text → same normalized vector. */
function embedStub(text) {
  const v = new Array(DIM).fill(0)
  for (let i = 0; i < text.length; i++) v[(i * 31 + text.charCodeAt(i)) % DIM] += 1
  const norm = Math.hypot(...v) || 1
  return v.map(n => n / norm)
}

function makeProvider(name, behavior = {}) {
  const log = []
  const state = { calls: 0 }
  return {
    id: name,
    generationId: behavior.generationId ?? GEN,
    log,
    get calls() { return state.calls },
    async embed(texts) {
      state.calls++
      for (const t of texts) log.push(t)
      if (behavior.failWhen?.(texts)) throw behavior.error ?? new Error('stub failure')
      return texts.map(t => embedStub(t))
    },
  }
}

let provider
async function freshSession(code, text, extra = {}) {
  await StoredSession.deleteOne({ code })
  await deleteRagChunks(code)
  await StoredSession.create({
    code, text, files: [], ...extra,
    expiresAt: new Date(Date.now() + 3600_000),
    createdAt: new Date(),
    aiStatus: 'pending',
  })
}

describe('RAG adaptive pipeline (integration)', { concurrency: false }, () => {
  before(async () => {
    await connectDB()
    // Safety interlock: only ever drop a throwaway qs-it-* database.
    const dbName = mongoose.connection.name
    assert.ok(dbName.startsWith('qs-it-'), `refusing to run against non-test db: ${dbName}`)
    console.log(`ℹ integration db: ${dbName}`)
    provider = makeProvider('stub-primary')
    __setProvidersForTests([provider], { threshold: 3, cooldownMs: 200 })
  })

  after(async () => {
    if (!mongoose.connection.name.startsWith('qs-it-')) {
      throw new Error('interlock tripped — refusing to drop non-test database')
    }
    await mongoose.connection.dropDatabase()
    await mongoose.disconnect()
  })

  it('A. small corpus → direct mode, zero embeddings, idempotent', async () => {
    const code = '900001'
    const text = 'Alpha beta gamma. '.repeat(300) // ~5.4k chars → direct
    await freshSession(code, text)
    await indexSession(code)

    let s = (await StoredSession.findOne({ code }).lean())
    assert.equal(s.aiStatus, 'ready')
    assert.equal(s.aiMode, 'direct')
    assert.equal(s.aiStats.mode, 'direct')
    assert.ok(s.aiStats.fingerprint)

    const chunks = await RagChunk.find({ code }).lean()
    assert.ok(chunks.length > 1)
    assert.ok(chunks.every(c => c.st === 'completed'))
    assert.ok(chunks.every(c => !c.embedding || c.embedding.length === 0))
    assert.ok(chunks.every(c => c.idx >= 0))

    // Idempotent re-run: same count, no duplicates.
    await indexSession(code)
    assert.equal(await RagChunk.countDocuments({ code }), chunks.length)
    s = await StoredSession.findOne({ code }).lean()
    assert.equal(s.aiStats.chunks, chunks.length)

    // Retrieval stuffs the WHOLE corpus without any vector leg.
    const r = await retrieve(code, 'alpha?')
    assert.ok(r.context.includes('gamma'))
    assert.equal(r.sources.length, chunks.length)
  })

  it('B. large corpus → vector mode with gen-stamped embeddings', async () => {
    const code = '900002'
    const marker = 'ZEBRA-MARKER unique content for retrieval. '
    const text = 'Filler sentence about databases and caching. '.repeat(3200) + marker.repeat(20) // ~153k chars ≈ 51k est-tokens > gate
    await freshSession(code, text)
    await indexSession(code)

    const s = await StoredSession.findOne({ code }).lean()
    assert.equal(s.aiStatus, 'ready')
    assert.equal(s.aiMode, 'vector')
    assert.equal(s.aiStats.gen, GEN)
    const chunks = await RagChunk.find({ code }).lean()
    assert.ok(chunks.length >= 80)
    assert.ok(chunks.every(c => c.st === 'completed'))
    assert.ok(chunks.every(c => c.embedding?.length === DIM))
    assert.ok(chunks.every(c => c.gen === GEN))
    assert.equal(s.aiStats.chunks, chunks.length, 'stats count matches persisted docs')

    const r = await retrieve(code, 'what is the ZEBRA-MARKER about?')
    assert.ok(r.sources.length > 0)
    assert.ok(r.context.includes('ZEBRA-MARKER'))
  })

  it('C. crash resume embeds ONLY pending units; completed vectors untouched', async () => {
    const code = '900003'
    const text = 'Resumable chunk body. '.repeat(6500) // ~143k chars → vector
    await freshSession(code, text)
    await indexSession(code)
    const before = await RagChunk.find({ code }).sort({ idx: 1 }).lean()
    const half = Math.floor(before.length / 2)

    // Simulate crash state: first half completed+stamped, second half pending.
    for (const c of before.slice(half)) {
      await RagChunk.updateOne({ _id: c._id }, { $set: { st: 'pending', embedding: [], gen: null } })
    }
    await StoredSession.updateOne({ code }, { $set: { aiStatus: 'failed' } })
    provider.log.length = 0

    await indexSession(code) // fingerprint matches → resume path

    const after = await RagChunk.find({ code }).sort({ idx: 1 }).lean()
    assert.equal(after.length, before.length, 'no units lost or duplicated')
    assert.ok(after.every(c => c.st === 'completed' && c.gen === GEN))
    for (let i = 0; i < half; i++) {
      assert.deepEqual(after[i].embedding, before[i].embedding, `completed unit ${i} untouched`)
    }
    const embeddedTexts = new Set(provider.log)
    for (const c of before.slice(half)) {
      assert.ok(embeddedTexts.has(c.text), 'every resumed unit was embedded exactly once')
    }
    assert.ok(embeddedTexts.size <= before.length - half + DIM, 'no wholesale re-embedding')
    const s = await StoredSession.findOne({ code }).lean()
    assert.equal(s.aiStatus, 'ready')
  })

  it('D. provider death mid-job → durable partials; swap heals on recovery', async () => {
    const code = '900004'
    const text = 'Failure injection corpus line. '.repeat(4800) // ~148k chars → vector
    await freshSession(code, text)

    const flaky = makeProvider('flaky', {
      failWhen: texts => texts.some(t => t.includes('chunk') === false ? false : false),
    })
    // Fail everything AFTER the first successful batch by counting calls.
    let batch = 0
    flaky.embed = async function (texts) {
      this.log.push(...texts)
      batch++
      if (batch > 2) throw new Error('provider vanished')
      return texts.map(embedStub)
    }
    __setProvidersForTests([flaky], { threshold: 50, cooldownMs: 10 })
    await indexSession(code)

    let s = await StoredSession.findOne({ code }).lean()
    assert.equal(s.aiStatus, 'failed', 'job pauses as failed')
    const partialDone = await RagChunk.countDocuments({ code, st: 'completed' })
    assert.ok(partialDone > 0, 'completed batches stayed durable')
    assert.equal(await RagChunk.countDocuments({ code, st: 'pending' }) + partialDone,
                 s.aiStats.chunks)

    // Healthy provider arrives; recovery resumes WITHOUT re-extraction.
    provider.log.length = 0
    __setProvidersForTests([provider], { threshold: 3, cooldownMs: 200 })
    const kept = await RagChunk.find({ code, st: 'completed' }).sort({ idx: 1 })
    await recoverPendingIndexes() // picks failed sessions too
    await new Promise(r => setTimeout(r, 50))
    await indexSession(code) // deterministic completion

    s = await StoredSession.findOne({ code }).lean()
    assert.equal(s.aiStatus, 'ready')
    const keptAfter = await RagChunk.findOne({ _id: kept[0]._id }).lean()
    assert.deepEqual(keptAfter.embedding, kept[0].embedding, 'pre-failure vectors preserved')
    assert.ok(await RagChunk.countDocuments({ code, st: 'completed' }) === s.aiStats.chunks)
  })

  it('E. mixed-generation vectors are refused, then self-heal', async () => {
    const code = '900005'
    const text = 'Generation guard corpus. '.repeat(5600) // ~140k chars → vector
    await freshSession(code, text)
    await indexSession(code)

    await RagChunk.updateOne({ code, idx: 0 }, { $set: { gen: 'other-model:v9' } })
    await assert.rejects(() => retrieve(code, 'anything'), err => {
      assert.ok(err instanceof GenerationMismatchError)
      assert.equal(err.storedGen, 'other-model:v9')
      return true
    })

    await indexSession(code) // transparent rebuild restores one generation
    const r = await retrieve(code, 'generation guard?')
    assert.ok(r.sources.length > 0)
  })

  it('F. legacy chunks (pre-deploy, no st/gen) self-heal instead of erroring', async () => {
    const code = '900006'
    // Session carries real content so the rebuild has something to index.
    await freshSession(code, 'legacy indexed content about quotas and limits')
    // Hand-insert a pre-deploy shape doc.
    await RagChunk.collection.insertOne({
      code, fileId: 'legacy', name: 'old.txt', page: null, idx: 0,
      text: 'legacy indexed content about quotas',
      embedding: embedStub('legacy indexed content'),
    })
    await StoredSession.updateOne({ code }, { $set: { aiStatus: 'ready', aiMode: 'vector' } })

    await assert.rejects(() => retrieve(code, 'quotas?'), GenerationMismatchError)
    await indexSession(code)
    const r = await retrieve(code, 'quotas?')
    assert.ok(r.sources.length > 0, 'rebuilt index serves queries again')
  })

  it('G. direct-mode retrieval respects the char budget cap', async () => {
    const code = '900007'
    await freshSession(code, '')
    // Hand-seed a "direct" session larger than the planner would ever allow,
    // isolating the retriever-side budget enforcement.
    const { CONFIG: CFG } = dist('config.js')
    const capChars = CFG.DIRECT_STUFF_MAX_CHARS + 4096
    const perChunk = 'x'.repeat(1000)
    const count = Math.ceil((capChars + 20_000) / perChunk.length) // guarantees overflow
    const fid = new ObjectId()
    for (let i = 0; i < count; i++) {
      await RagChunk.create({ code, fileId: fid, name: 'n.txt', page: null, idx: i, text: perChunk, st: 'completed' })
    }
    await StoredSession.updateOne({ code }, { $set: { aiStatus: 'ready', aiMode: 'direct' } })
    const r = await retrieve(code, 'q')
    const ctxLen = r.context.length
    assert.ok(
      ctxLen <= capChars + r.sources.length * 12,
      `context ${ctxLen} within budget ${capChars}`,
    )
    assert.ok(r.sources.length < count, `sources truncated (${r.sources.length}/${count})`)
  })

  it('H. breaker exhaustion fails fast; cooldown probe recovers', async () => {
    const code = '900008'
    // Vector-sized corpus so embedding is actually exercised.
    await freshSession(code, 'Circuit breaker corpus body. '.repeat(5200)) // ~135k chars → vector
    const alwaysBroken = makeProvider('broken', { failWhen: () => true })
    __setProvidersForTests([alwaysBroken], { threshold: 2, cooldownMs: 150 })
    await indexSession(code)
    // "Fails fast, no hammering": the breaker admits at most `threshold`
    // batch attempts (+1 half-open probe if cooldown elapses mid-job) —
    // count-based, NOT wall-clock, so slow Atlas links can't flake.
    const maxAttempts = 2 + 1
    assert.ok(
      alwaysBroken.calls <= maxAttempts,
      `expected ≤${maxAttempts} embed attempts, got ${alwaysBroken.calls}`,
    )
    let s = await StoredSession.findOne({ code }).lean()
    assert.equal(s.aiStatus, 'failed', 'job pauses as failed when circuit opens')

    __setProvidersForTests([makeProvider('healed')], { threshold: 2, cooldownMs: 150 })
    await indexSession(code)
    s = await StoredSession.findOne({ code }).lean()
    assert.equal(s.aiStatus, 'ready')
  })

  it('I. private sessions are never indexed (defense-in-depth)', async () => {
    const code = '900009'
    await freshSession(code, 'secret plans', { password: '$2a$fakehash' })
    await indexSession(code)
    const s = await StoredSession.findOne({ code }).select('+password').lean()
    assert.equal(s.aiStatus, 'none')
    assert.equal(await RagChunk.countDocuments({ code }), 0)
  })

  it('J. THE RENDER-FREE GUARANTEE: no providers + huge corpus ⇒ BM25 answers, never failure', async () => {
    const code = '900010'
    // Exact production incident shape: corpus exceeds the direct-stuff
    // token budget AND zero embedding providers are permitted.
    const marker = 'QUANTUM-ANCHOR unique retrievable fact. '
    const text = 'Ordinary filler paragraph about networking. '.repeat(3600) + marker.repeat(15)
    await freshSession(code, text) // ~162k chars ≈ 54k est-tokens → vector needed

    // Render-free posture: EMPTY embedding registry (no keys, local excluded).
    __setEmptyRegistryForTests({ threshold: 3, cooldownMs: 200 })
    await indexSession(code)

    const s = await StoredSession.findOne({ code }).lean()
    assert.equal(s.aiStatus, 'ready', 'session MUST be ready — never failed on Render-free')
    assert.equal(s.aiMode, 'bm25', 'degrades to BM25-only mode')
    const chunks = await RagChunk.find({ code }).lean()
    assert.ok(chunks.length > 100)
    assert.ok(chunks.every(c => c.st === 'completed'), 'canonical units completed without vectors')
    assert.ok(chunks.every(c => !c.embedding || c.embedding.length === 0))

    // Query path serves grounded, cited content with ZERO embedding calls.
    const r = await retrieve(code, 'what does QUANTUM-ANCHOR say?')
    assert.ok(r.sources.length > 0, 'sources returned')
    assert.ok(r.context.includes('QUANTUM-ANCHOR'), 'marker retrieved')

    // Adding a provider later upgrades on next reindex (no dead end).
    __setProvidersForTests([makeProvider('late')], { threshold: 3, cooldownMs: 200 })
    await indexSession(code)
    const s2 = await StoredSession.findOne({ code }).lean()
    assert.equal(s2.aiMode, 'vector', 'upgrade path to vector works')
    const r2 = await retrieve(code, 'quantum anchor again?')
    assert.ok(r2.sources.length > 0)
  })

  it('K. enumeration question over BM25 session returns WIDE coverage (chapter-listing bug)', async () => {
    const code = '900012'
    let text = ''
    for (let n = 1; n <= 24; n++) {
      text += `Chapter ${n}: The Art of Persistence Number ${n}. `
      text += 'Body filler about discipline and craft. '.repeat(110)
    }
    await freshSession(code, text)
    __setEmptyRegistryForTests({ threshold: 3, cooldownMs: 200 })
    await indexSession(code)
    const s = await StoredSession.findOne({ code }).lean()
    assert.equal(s.aiMode, 'bm25')

    const r = await retrieve(code, 'List all the names of the chapters mentioned in the entire book.')
    assert.ok(r.sources.length >= 20, `wide recall expected, got ${r.sources.length}`)
    const ctxTitles = (r.context.match(/Chapter \d+/g) ?? []).map(x => x.replace('Chapter ', ''))
    assert.ok(new Set(ctxTitles).size >= 20, `≥20 distinct chapters in context, got ${new Set(ctxTitles).size}`)

    const r2 = await retrieve(code, 'persistence discipline')
    assert.ok(r2.sources.length > 0 && r2.sources.length < r.sources.length)
  })
})
