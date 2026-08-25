import MiniSearch from 'minisearch'
import { AutoTokenizer, AutoModelForSequenceClassification } from '@huggingface/transformers'
import logger from '../logger'
import { CONFIG } from '../config'
import type { Chunk, Source } from './types'
import {
  embedQuery,
  GenerationMismatchError,
  ACTIVE_GENERATION_ID,
} from './embedding/orchestrator'
import { clearAnswerCache } from './answerCache'
import { RagChunk, StoredSession } from '../db'

// ── Hybrid retrieval ─────────────────────────────────────────────────────────
//  1. BM25 (MiniSearch) over chunk text          → top-K lexical
//  2. Cosine similarity (brute force)            → top-K semantic   (≤4k chunks ⇒ ms)
//  3. Reciprocal Rank Fusion (k=60)              → merged top-N
//  4. Cross-encoder rerank (bge-reranker-base)   → final top-5 with scores
//
// The per-session index is built lazily on first query and LRU-capped so a
// long-lived server never accumulates unbounded state. Chunks themselves stay
// in Mongo; only the in-memory search structures live here.

const RRF_K = 60
const CANDIDATES_PER_LEG = 25
const FUSION_KEEP = 12
const FINAL_TOP_K = 5
// Safety margin over DIRECT_STUFF_MAX_CHARS so a planner-approved corpus is
// never truncated here even after per-chunk prefix overhead.
const DIRECT_BUDGET_MARGIN_CHARS = 4096

interface SessionIndex {
  minisearch: MiniSearch<Chunk>
  chunks: Chunk[]
  vectors: Float32Array[] // parallel to chunks
}

const indexCache = new Map<string, SessionIndex>()
const INDEX_CACHE_MAX = CONFIG.RAG_INDEX_CACHE_MAX // bounded so the LRU can never balloon RAM on small hosts

function evictIfNeeded(): void {
  while (indexCache.size >= INDEX_CACHE_MAX) {
    // Map preserves insertion order — evict oldest.
    const oldest = indexCache.keys().next().value as string | undefined
    if (!oldest) break
    dropSessionIndex(oldest)
  }
}

export function dropSessionIndex(code: string): void {
  indexCache.delete(code)
  // Keep answer cache consistent with the (possibly re-indexed) corpus.
  clearAnswerCache(code)
}

export function getSessionIndex(code: string): SessionIndex | undefined {
  return indexCache.get(code)
}

export function putSessionIndex(
  code: string,
  chunks: Chunk[],
  embeddings: number[][]
): SessionIndex {
  evictIfNeeded()
  const idx: SessionIndex = {
    chunks,
    vectors: embeddings.map(e => Float32Array.from(e)),
    minisearch: new MiniSearch<Chunk>({
      fields: ['text'],
      storeFields: ['name', 'page'],
      searchOptions: { prefix: true, fuzzy: 0.2, boost: { text: 1 } },
    }),
  }
  // MiniSearch requires a unique "id" field per document.
  idx.minisearch.addAll(chunks.map(c => ({ ...c, id: c.idx })))
  indexCache.set(code, idx)
  return idx
}

/** Build (or reuse) the in-memory index straight from Mongo. */
export async function ensureSessionIndex(code: string): Promise<SessionIndex> {
  const cached = indexCache.get(code)
  if (cached) return cached
  // Legacy chunks (pre durable-units deploy) carry no `st` field — they must
  // still load so the generation check below can trigger their transparent
  // rebuild instead of failing the query outright.
  const docs = await RagChunk.find({
    code,
    $or: [{ st: 'completed' }, { st: { $exists: false } }],
    embedding: { $exists: true, $ne: [] },
  })
    .select('fileId name page idx text embedding gen')
    .lean()
  if (!Array.isArray(docs) || docs.length === 0) throw new Error('no_chunks')
  // Vector-space consistency (doc §35/Invariant 4): refuse to query across
  // embedding generations. A mismatch triggers one transparent reindex via
  // the /ai/query handler instead of silently comparing incommensurable
  // vectors.
  const mismatched = docs.find(d => (d.gen ?? null) !== ACTIVE_GENERATION_ID)
  if (mismatched) throw new GenerationMismatchError(mismatched.gen ?? 'legacy', ACTIVE_GENERATION_ID)
  return putSessionIndex(
    code,
    docs.map(d => ({ fileId: String(d.fileId), name: d.name, page: d.page ?? null, idx: d.idx, text: d.text })),
    docs.map(d => d.embedding ?? []),
  )
}

// ── Direct-mode retrieval ────────────────────────────────────────────────────
// Small corpora skip BM25/vectors entirely: the WHOLE canonical content
// becomes the context. Nothing is lost between chunks — near-perfect by
// construction — and the embedding model never loads for these sessions.

async function retrieveDirect(code: string): Promise<RetrievalResult> {
  const docs = await RagChunk.find({ code })
    .select('fileId name page idx text')
    .sort({ idx: 1 })
    .lean()
  if (!Array.isArray(docs) || docs.length === 0) throw new Error('no_chunks')

  let budget = CONFIG.DIRECT_STUFF_MAX_CHARS + DIRECT_BUDGET_MARGIN_CHARS
  const sources: Source[] = []
  const parts: string[] = []
  for (const d of docs) {
    if (budget <= 0) break
    const take = d.text.slice(0, budget)
    budget -= take.length
    parts.push(`[[${sources.length + 1}]] ${take}`)
    sources.push({
      name: d.name,
      fileId: String(d.fileId),
      page: d.page ?? null,
      score: 1,
      snippet: d.text.slice(0, 240),
    })
  }
  return { sources, context: parts.join('\n\n---\n\n') }
}

// Exported for unit tests — pure ranking math.
export function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i]
  return dot // both normalized
}

// Exported for unit tests — pure ranking math.
export function reciprocalFusion(
  lists: { chunkIdx: number; rank: number }[][]
): { chunkIdx: number; rrf: number }[] {
  const scores = new Map<number, number>()
  for (const list of lists) {
    list.forEach(({ chunkIdx }, i) => {
      scores.set(chunkIdx, (scores.get(chunkIdx) ?? 0) + 1 / (RRF_K + i + 1))
    })
  }
  return [...scores.entries()]
    .map(([chunkIdx, rrf]) => ({ chunkIdx, rrf }))
    .sort((a, b) => b.rrf - a.rrf)
    .slice(0, FUSION_KEEP)
}

// ── Cross-encoder reranker ───────────────────────────────────────────────────
// transformers.js has no dedicated cross-encoder pipeline; drive
// AutoModelForSequenceClassification manually. bge-reranker-base emits one
// relevance logit per (query, passage) pair — raw logits order fine.

interface RerankerBundle {
  score: (query: string, passages: string[]) => Promise<number[]>
}

let rerankerPromise: Promise<RerankerBundle> | null = null

function getReranker(): Promise<RerankerBundle> {
  if (!rerankerPromise) {
    rerankerPromise = (async () => {
      const start = Date.now()
      const tokenizer = await AutoTokenizer.from_pretrained(CONFIG.RERANK_MODEL)
      const model = await AutoModelForSequenceClassification.from_pretrained(
        CONFIG.RERANK_MODEL,
        { dtype: 'q8' }
      )
      logger.info({ ms: Date.now() - start, model: CONFIG.RERANK_MODEL }, '[rag] reranker loaded')
      return {
        async score(query: string, passages: string[]) {
          // transformers.js v4: pairs are passed via the text_pair OPTION.
          // (The {text, text_pair} per-item object form is broken in v4 and
          // silently encodes empty sequences.)
          const queries = passages.map(() => query)
          const inputs = (tokenizer as unknown as (
            t: string[],
            o?: Record<string, unknown>
          ) => Record<string, unknown>)(queries, {
            text_pair: passages,
            padding: true,
            truncation: true,
          })
          const output = await (model as unknown as (
            i: Record<string, unknown>
          ) => Promise<{ logits: { tolist(): number[][] } }>)(inputs)
          const logits = output.logits as { tolist(): number[][] }
          return logits.tolist().map((row: number[]) => row[0])
        },
      }
    })().catch(err => {
      rerankerPromise = null
      throw err
    })
  }
  return rerankerPromise
}

async function rerank(query: string, candidates: Chunk[]): Promise<{ chunk: Chunk; score: number }[]> {
  if (candidates.length === 0) return []
  if (!CONFIG.RAG_RERANK_ENABLED) {
    // Reranker disabled (default on small/free hosts): trust the hybrid
    // fusion order. Eval gate: hit@3=1.0 pre-rerank.
    return candidates.map((chunk, i) => ({ chunk, score: 1 / (i + 1) }))
  }
  try {
    const rr = await getReranker()
    const scores = await rr.score(query, candidates.map(c => c.text))
    const scored = candidates.map((chunk, i) => ({ chunk, score: scores[i] ?? 0 }))
    scored.sort((a, b) => b.score - a.score)
    return scored
  } catch (err) {
    // Reranker failure must not kill retrieval — fall back to fused order.
    logger.warn({ err }, '[rag] reranker failed — using fusion order')
    return candidates.map((chunk, i) => ({ chunk, score: 1 / (i + 1) }))
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

export interface RetrievalResult {
  sources: Source[]
  context: string
}

export async function retrieve(code: string, question: string): Promise<RetrievalResult> {
  // Route by session index mode (analyzer decision at index time).
  const session = await StoredSession.findOne({ code }).select('aiMode').lean()
  if (session?.aiMode === 'direct') return retrieveDirect(code)

  const idx = await ensureSessionIndex(code)

  // Leg 1: BM25
  const bmHits = idx.minisearch.search(question).slice(0, CANDIDATES_PER_LEG)

  // Leg 2: semantic
  const qvec = Float32Array.from(await embedQuery(question))
  const cosScores: { chunkIdx: number; score: number }[] = []
  for (let i = 0; i < idx.vectors.length; i++) {
    cosScores.push({ chunkIdx: i, score: cosine(qvec, idx.vectors[i]) })
  }
  cosScores.sort((a, b) => b.score - a.score)
  const vecHits = cosScores.slice(0, CANDIDATES_PER_LEG)

  // Fuse
  const fused = reciprocalFusion([
    bmHits.map(h => ({ chunkIdx: idx.chunks.findIndex(c => c.idx === h.id), rank: h.score })),
    vecHits.map(h => ({ chunkIdx: h.chunkIdx, rank: h.score })),
  ]).filter(f => f.chunkIdx >= 0)

  const candidates = fused.map(f => idx.chunks[f.chunkIdx])

  // Rerank → final top-K
  const ranked = await rerank(question, candidates)
  const top = ranked.slice(0, FINAL_TOP_K)

  const sources: Source[] = top.map(({ chunk, score }) => ({
    name: chunk.name,
    fileId: chunk.fileId,
    page: chunk.page,
    score: Number(score.toFixed(4)),
    snippet: chunk.text.slice(0, 240),
  }))

  const context = top
    .map(({ chunk }, i) => `[[${i + 1}]] ${chunk.text}`)
    .join('\n\n---\n\n')

  return { sources, context }
}
