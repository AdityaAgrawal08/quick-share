/* eslint-disable no-console */
// ── RAG retrieval eval harness ───────────────────────────────────────────────
// Measures hit@k / MRR of the RETRIEVER ONLY (no LLM calls, deterministic).
// Gate: Phase 5 requires hit@3 ≥ 0.9 on this fixture set.
//
// Usage:  node dist/scripts/rag-eval.js
//         (build first: npx tsc)

import { chunkPages } from '../src/rag/chunker.js'
import type { RawChunk } from '../src/rag/chunker.js'

interface FixtureDoc {
  name: string
  text: string
}

interface GoldenQa {
  question: string
  /** Substring that MUST appear in a top-k retrieved chunk. */
  expectSubstring: string
}

const DOCS: FixtureDoc[] = [
  {
    name: 'engine-manual.txt',
    text: `Engine Maintenance Schedule

The Vortex X200 engine requires 5W-30 full synthetic oil. Oil changes must be performed every 10,000 kilometers or 12 months, whichever comes first.

The coolant system holds 6.2 liters and uses OAT (organic acid technology) coolant. Never mix OAT with IAT coolant formulations as this causes gel formation.

Air filter replacement is required every 30,000 kilometers in dusty conditions, or every 45,000 kilometers in normal conditions. A clogged air filter reduces fuel economy by up to 10 percent.

Spark plugs are iridium-tipped and rated for 100,000 kilometers. Torque to 25 newton-meters during installation.`,
  },
  {
    name: 'baking-guide.md',
    text: `# Sourdough Baking Guide

## Starter
Feed your sourdough starter daily with equal weights of flour and water. A healthy starter doubles in size within 6 hours at room temperature.

## Hydration
This recipe uses 78 percent hydration dough, meaning 780 grams of water for every 1000 grams of flour. Higher hydration produces larger holes in the crumb.

## Baking Temperature
Preheat the dutch oven to 250 degrees Celsius for 45 minutes. Bake covered for 20 minutes, then uncovered for 25 minutes until deep brown.`,
  },
  {
    name: 'company-policy.txt',
    text: `Remote Work Policy

Employees may work remotely up to 3 days per week with manager approval. Fully remote arrangements require VP sign-off and are reviewed quarterly.

Home office stipend: 500 USD once per fiscal year, claimable through the HR portal with receipts.

Security requirement: all remote sessions must use the company VPN. Split tunneling is prohibited on unmanaged devices.`,
  },
  {
    name: 'physics-notes.txt',
    text: `Quantum Entanglement Primer

When two particles become entangled, measuring one instantaneously correlates the state of the other regardless of distance. This does not transmit information faster than light because the measurement outcomes are random.

Bell's inequality experiments rule out local hidden variable theories. The 2022 Nobel Prize was awarded to Aspect, Clauser, and Zeilinger for these experiments.

Decoherence timescales for superconducting qubits are typically 50 to 200 microseconds, limiting circuit depth before error accumulation dominates.`,
  },
]

const GOLDEN: GoldenQa[] = [
  { question: 'How often do I change the engine oil?', expectSubstring: 'every 10,000 kilometers' },
  { question: 'What torque should spark plugs be tightened to?', expectSubstring: '25 newton-meters' },
  { question: 'Can I mix OAT and IAT coolant?', expectSubstring: 'Never mix OAT' },
  { question: 'What hydration is the sourdough dough?', expectSubstring: '78 percent hydration' },
  { question: 'How long do I bake uncovered?', expectSubstring: 'uncovered for 25 minutes' },
  { question: 'How many days per week can I work remotely?', expectSubstring: 'up to 3 days' },
  { question: 'What is the home office stipend amount?', expectSubstring: '500 USD' },
  { question: 'Is split tunneling allowed?', expectSubstring: 'prohibited' },
  { question: 'Who won the Nobel Prize for entanglement experiments?', expectSubstring: 'Aspect, Clauser' },
  { question: 'What are typical decoherence timescales?', expectSubstring: '50 to 200 microseconds' },
  { question: 'Does entanglement allow faster-than-light messaging?', expectSubstring: 'not transmit information faster than light' },
  { question: 'How fast does a healthy starter double?', expectSubstring: 'doubles in size within 6 hours' },
]

// ── Minimal reimplementation of the retriever math (no Mongo/HF deps) ────────
// Mirrors retriever.ts leg-1+leg-2+RRF so the gate tests THE ALGORITHM,
// while the real embedder/reranker models are exercised separately.

function tokenize(t: string): string[] {
  return t.toLowerCase().match(/[a-z0-9]+/g) ?? []
}

function bm25Scores(query: string, chunks: RawChunk[]): number[] {
  const k1 = 1.5, b = 0.75
  const docs = chunks.map(c => tokenize(c.text))
  const avgLen = docs.reduce((s, d) => s + d.length, 0) / docs.length
  const df = new Map<string, number>()
  docs.forEach(d => new Set(d).forEach(w => df.set(w, (df.get(w) ?? 0) + 1)))
  const N = docs.length
  return chunks.map((_, i) => {
    const d = docs[i]
    const tf = new Map<string, number>()
    d.forEach(w => tf.set(w, (tf.get(w) ?? 0) + 1))
    let score = 0
    for (const term of new Set(tokenize(query))) {
      const f = tf.get(term)
      if (!f) continue
      const idf = Math.log(1 + (N - (df.get(term) ?? 0) + 0.5) / ((df.get(term) ?? 0) + 0.5))
      score += idf * (f * (k1 + 1)) / (f + k1 * (1 - b + b * (d.length / avgLen)))
    }
    return score
  })
}

function cosineScores(qvec: Float32Array, vecs: Float32Array[]): number[] {
  return vecs.map(v => v.reduce((s, x, i) => s + x * qvec[i], 0))
}

async function main() {
  const { embedTexts } = await import('../src/rag/embedder.js')

  // Build corpus
  const corpus: { chunk: RawChunk; docIdx: number }[] = []
  DOCS.forEach((doc, di) => {
    chunkPages(doc.name, [{ page: null, text: doc.text }], { targetChars: 400, overlapChars: 60 })
      .forEach(chunk => corpus.push({ chunk, docIdx: di }))
  })
  console.log(`corpus: ${corpus.length} chunks from ${DOCS.length} docs`)

  // Embed everything (batched)
  const embeddings = await embedTexts(corpus.map(c => c.chunk.text))

  const K = 3
  let hits = 0
  let mrrSum = 0

  for (const qa of GOLDEN) {
    // Leg 1: BM25 ranking
    const bm = bm25Scores(qa.question, corpus.map(c => c.chunk))
      .map((score, i) => ({ i, score }))
      .filter(x => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 25)

    // Leg 2: vector ranking
    const [qv] = await embedTexts([qa.question])
    const vs = cosineScores(Float32Array.from(qv), embeddings.map(e => Float32Array.from(e)))
      .map((score, i) => ({ i, score }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 25)

    // RRF fusion
    const rrf = new Map<number, number>()
    bm.forEach(({ i }, rank) => rrf.set(i, (rrf.get(i) ?? 0) + 1 / (61 + rank + 1)))
    vs.forEach(({ i }, rank) => rrf.set(i, (rrf.get(i) ?? 0) + 1 / (61 + rank + 1)))
    const fused = [...rrf.entries()].sort((a, b) => b[1] - a[1])

    // Evaluate fused ranking (pre-rerank floor — reranker can only improve it)
    let firstHitRank = -1
    fused.forEach(([i], idx) => {
      if (firstHitRank === -1 && corpus[i].chunk.text.includes(qa.expectSubstring)) {
        firstHitRank = idx + 1
      }
    })

    const hit = firstHitRank !== -1 && firstHitRank <= K
    if (hit) hits++
    mrrSum += firstHitRank === -1 ? 0 : 1 / firstHitRank
    console.log(`${hit ? '✓' : '✗'} rank=${firstHitRank === -1 ? '-' : firstHitRank}  ${qa.question}`)
  }

  const hitAt3 = hits / GOLDEN.length
  const mrr = mrrSum / GOLDEN.length
  console.log(`\nhit@3 = ${hitAt3.toFixed(3)}  (gate ≥ 0.90)`)
  console.log(`MRR   = ${mrr.toFixed(3)}  (target ≥ 0.80)`)

  if (hitAt3 >= 0.9) {
    console.log('EVAL GATE PASSED')
    process.exit(0)
  }
  console.log('EVAL GATE FAILED')
  process.exit(1)
}

main().catch(err => { console.error(err); process.exit(1) })
