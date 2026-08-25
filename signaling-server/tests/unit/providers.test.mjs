// Unit tests — external provider adapters & env registry assembly (P2).
import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const dist = p => require(`../../dist/${p}`)

const ENV_KEYS = ['COHERE_API_KEY', 'VOYAGE_API_KEY', 'RAG_PROVIDER_ORDER', 'INSTANCE_MEMORY_MB']

function bustConfig() {
  for (const m of ['config.js', 'rag/memory-profile.js', 'rag/embedding/orchestrator.js']) {
    delete require.cache[require.resolve(`../../dist/${m}`)]
  }
}

function jsonResponse(body, status = 200) {
  return { ok: status < 400, status, text: async () => JSON.stringify(body), json: async () => body }
}

describe('CohereProvider', () => {
  afterEach(() => { delete process.env.COHERE_API_KEY })

  it('sends v2 embed payload with auth, dims and float type', async () => {
    const { CohereProvider } = dist('rag/embedding/providers/cohere.js')
    const calls = []
    const fakeFetch = async (url, init) => {
      calls.push({ url, init })
      return jsonResponse({ embeddings: { float: [[1, 0], [0, 1]] } })
    }
    const p = new CohereProvider('ck-test', fakeFetch)
    const vectors = await p.embed(['hello world', 'second text'])
    assert.equal(calls.length, 1)
    assert.equal(calls[0].url, 'https://api.cohere.com/v2/embed')
    assert.equal(calls[0].init.headers.Authorization, 'Bearer ck-test')
    const body = JSON.parse(calls[0].init.body)
    assert.equal(body.model, 'embed-v4.0')
    assert.deepEqual(body.texts, ['hello world', 'second text'])
    assert.equal(body.input_type, 'document')
    assert.deepEqual(body.embedding_types, ['float'])
    assert.equal(body.output_dimension, 1536)
    assert.equal(p.generationId, 'cohere:embed-v4.0:1536:cosine')
    assert.equal(vectors.length, 2)
  })

  it('honors query intent', async () => {
    const { CohereProvider } = dist('rag/embedding/providers/cohere.js')
    const bodies = []
    const fakeFetch = async (_u, init) => { bodies.push(JSON.parse(init.body)); return jsonResponse({ embeddings: { float: [[1]] } }) }
    const p = new CohereProvider('ck', fakeFetch)
    await p.embed(['q?'], { inputType: 'query' })
    assert.equal(bodies[0].input_type, 'query')
  })

  it('token-aware slicing splits >96 items into multiple requests', async () => {
    const { CohereProvider } = dist('rag/embedding/providers/cohere.js')
    let calls = 0
    const sizes = []
    const fakeFetch = async (_u, init) => {
      calls++
      const body = JSON.parse(init.body)
      sizes.push(body.texts.length)
      return jsonResponse({ embeddings: { float: body.texts.map(() => [1]) } })
    }
    const p = new CohereProvider('ck', fakeFetch)
    const out = await p.embed(Array.from({ length: 200 }, (_, i) => `t${i} `.repeat(10)))
    assert.equal(out.length, 200)
    assert.equal(calls, 3) // 96 + 96 + 8
    assert.ok(sizes[0] === 96 && sizes[1] === 96 && sizes[2] === 8)
  })

  it('surfaces HTTP status for the classifier (429 → quota)', async () => {
    const { CohereProvider } = dist('rag/embedding/providers/cohere.js')
    const { classifyEmbeddingError } = dist('rag/embedding/provider.js')
    const p = new CohereProvider('ck', async () => jsonResponse({ message: 'rate limited' }, 429))
    await assert.rejects(() => p.embed(['x']), err => {
      assert.equal(err.status, 429)
      assert.equal(classifyEmbeddingError(err).kind, 'quota')
      return true
    })
  })
})

describe('VoyageProvider', () => {
  afterEach(() => { delete process.env.VOYAGE_API_KEY })

  it('sends v1 embeddings payload and maps data[].embedding', async () => {
    const { VoyageProvider } = dist('rag/embedding/providers/voyage.js')
    const calls = []
    const fakeFetch = async (url, init) => {
      calls.push({ url, init })
      return jsonResponse({ data: [{ embedding: [1, 0] }, { embedding: [0, 1] }] })
    }
    const p = new VoyageProvider('vk-test', fakeFetch)
    const vectors = await p.embed(['a', 'b'], { inputType: 'query' })
    assert.equal(calls[0].url, 'https://api.voyageai.com/v1/embeddings')
    assert.equal(calls[0].init.headers.Authorization, 'Bearer vk-test')
    const body = JSON.parse(calls[0].init.body)
    assert.equal(body.model, 'voyage-4-lite')
    assert.deepEqual(body.input, ['a', 'b'])
    assert.equal(body.input_type, 'query')
    assert.equal(body.output_dimension, 1024)
    assert.equal(p.generationId, 'voyage:voyage-4-lite:1024:cosine')
    assert.deepEqual(vectors, [[1, 0], [0, 1]])
  })
})

describe('env registry assembly (RAG_PROVIDER_ORDER)', () => {
  afterEach(() => {
    for (const k of ENV_KEYS) delete process.env[k]
    bustConfig()
    dist('rag/memory-profile.js').__resetMemoryProfileForTests()
  })

  function freshOrchestrator() {
    bustConfig()
    const orch = dist('rag/embedding/orchestrator.js')
    // empty providers list ⇒ rebuild from env registry
    orch.__setProvidersForTests([])
    return orch.providerHealth().map(h => h.id)
  }

  it('keys present → cohere,voyage ordered before local', () => {
    process.env.INSTANCE_MEMORY_MB = '8192' // allow local too
    process.env.COHERE_API_KEY = 'ck'
    process.env.VOYAGE_API_KEY = 'vk'
    assert.deepEqual(freshOrchestrator(), ['cohere', 'voyage', 'local-bge'])
  })

  it('RAG_PROVIDER_ORDER reorders; missing keys drop providers', () => {
    process.env.INSTANCE_MEMORY_MB = '8192'
    process.env.VOYAGE_API_KEY = 'vk'
    process.env.RAG_PROVIDER_ORDER = 'voyage,local,cohere'
    assert.deepEqual(freshOrchestrator(), ['voyage', 'local-bge'])
  })

  it('TINY without keys ⇒ empty registry (direct-only host)', () => {
    process.env.INSTANCE_MEMORY_MB = '512'
    assert.deepEqual(freshOrchestrator(), [])
  })
})
