import { CONFIG } from '../config'
import logger from '../logger'
import {
  StoredSession,
  RagChunk,
  deleteRagChunks,
  readGridFile,
} from '../db'
import { extractFileText, isSupportedForExtraction } from './extractor'
import { chunkPages } from './chunker'
import { planCorpus } from './analyzer'
import type { CorpusPlan } from './analyzer'
import { embedWithFailover, EmbeddingUnavailableError, listRegisteredGenerations } from './embedding/orchestrator'
import { EmbeddingError } from './embedding/provider'
import type { Chunk } from './types'
import { dropSessionIndex } from './retriever'

// ── Index pipeline ───────────────────────────────────────────────────────────
// publish ──► indexSession(code)   (async, fire-and-forget, never blocks)
//
// Architecture (quick-share-rag-adaptive-architecture.md):
//  • Canonical chunks are persisted BEFORE embedding (durable work units,
//    §29–§32). Each batch completion is a durable Mongo write — the DB, not
//    the provider response, is the source of completion truth (§44).
//  • A provider failure mid-job leaves completed batches intact; recovery
//    resumes ONLY pending chunks without re-extracting/re-chunking (§33/§41).
//  • Small corpora take the 'direct' path (full-content stuffing at query
//    time) and never load the ONNX model.
//  • One job per code AND one job globally — peak-RAM containment.

const EMBED_BATCH = Number(process.env.RAG_EMBED_BATCH ?? 16) // small batches keep ORT activation memory low on 512MB hosts
const MONGO_INSERT_BATCH = Number(process.env.RAG_MONGO_INSERT_BATCH ?? 100)

const inFlight = new Map<string, Promise<void>>()
let globalJob: Promise<void> = Promise.resolve()

export function isIndexing(code: string): boolean {
  return inFlight.has(code)
}

export function indexSession(code: string): Promise<void> {
  const existing = inFlight.get(code)
  if (existing) return existing

  // Chain behind whatever job is currently running (global concurrency = 1).
  const run = globalJob.then(() => runIndex(code))
  const job = run.finally(() => inFlight.delete(code))
  inFlight.set(code, job)
  // Keep the chain alive even if a job fails.
  globalJob = run.catch(() => {})
  return job
}

/** Free V8 heap between heavy stages when --expose-gc is enabled. */
function releaseMemory(): void {
  if (typeof globalThis.gc === 'function') globalThis.gc()
}

/** Stable corpus fingerprint — resume only when the corpus is unchanged. */
export function corpusFingerprint(session: { files?: { gridfsId: { toString(): string } }[]; text?: string }): string {
  const fileIds = (session.files ?? []).map(f => f.gridfsId.toString())
  return `${fileIds.join(',')}|${session.text?.length ?? 0}`
}

async function runIndex(code: string): Promise<void> {
  try {
    await StoredSession.updateOne({ code }, { $set: { aiStatus: 'pending' } })
    dropSessionIndex(code)

    const session = await StoredSession.findOne({ code }).select('+password').lean()
    if (!session) return // expired mid-flight; expiry cleanup handles chunks

    // Private (E2EE) sessions are NEVER indexed — defense-in-depth even if a
    // future call site forgets to check.
    if (session.password) {
      await StoredSession.updateOne({ code }, { $set: { aiStatus: 'none', aiMode: null } })
      logger.info({ code }, '[rag] skipping private session')
      return
    }

    const fingerprint = corpusFingerprint(session)
    const prevStats = session.aiStats
    const prevChunks = prevStats?.chunks
    const prevFailedFiles = prevStats?.failedFiles ?? []

    // ── Resume / rebuild classification (doc §33, §38–§40):
    //   • resume  — same corpus, completed units in ONE registered generation
    //               → finish only pending units (cheap).
    //   • rebuild — same corpus but the persisted index is mixed-generation or
    //               from an unregistered model → reset ALL units and re-embed
    //               from canonical chunks; NEVER re-read source files (§41).
    //   • fresh   — anything else → full extraction/chunking.
    let failedFiles: string[]
    let workChunks: Chunk[]
    let truncated = false
    let totalChars: number
    const anchorMatches = Boolean(
      prevStats?.fingerprint === fingerprint &&
      prevStats?.mode === 'vector' &&
      typeof prevChunks === 'number' &&
      prevChunks > 0
    )
    let resumable = false
    let rebuild = false
    if (CONFIG.RAG_RESUME_ENABLED && anchorMatches) {
      const gens = await RagChunk.distinct('gen', { code, st: 'completed' }).catch(() => [] as (string | null)[])
      const registered = listRegisteredGenerations()
      if (gens.length === 1 && gens[0] && registered.includes(gens[0])) {
        resumable = true
      } else if (gens.length > 0) {
        rebuild = true
      } // zero completed units → nothing durable to keep: fresh
    }
    const resumed = resumable
    let plan: CorpusPlan | null = resumed || rebuild ? { mode: 'vector', totalChars: 0, chunkCount: 0 } : null

    if (rebuild) {
      logger.info({ code }, '[rag] rebuilding index — generation change detected')
      await RagChunk.updateMany(
        { code },
        { $set: { st: 'pending', embedding: [], gen: null } },
      )
      const docs = await RagChunk.find({ code }).select('fileId name page idx text').lean()
      workChunks = docs.map(d => ({
        fileId: String(d.fileId),
        name: d.name,
        page: d.page ?? null,
        idx: d.idx,
        text: d.text,
      }))
      failedFiles = prevFailedFiles
      totalChars = workChunks.reduce((n, c) => n + c.text.length, 0)
      truncated = false
    } else if (resumed) {
      const pendDocs = await RagChunk.find({ code, st: 'pending' })
        .select('fileId name page idx text')
        .lean()
      if (pendDocs.length === 0) {
        // Everything already completed (e.g. crashed after last write but
        // before the status flip) → just finalize from DB truth.
        const [persisted, gens] = await Promise.all([
          RagChunk.countDocuments({ code }),
          RagChunk.distinct('gen', { code, st: 'completed' }),
        ])
        await finalizeReady(code, {
          mode: 'vector',
          chunks: persisted,
          files: session.files.length - prevFailedFiles.length,
          failedFiles: prevFailedFiles,
          gen: gens.length === 1 ? gens[0] : undefined,
          fingerprint,
        })
        return
      }
      workChunks = pendDocs.map(d => ({
        fileId: String(d.fileId),
        name: d.name,
        page: d.page ?? null,
        idx: d.idx,
        text: d.text,
      }))
      failedFiles = prevFailedFiles
      totalChars = 0
      logger.info(
        { code, pending: workChunks.length },
        '[rag] resuming index job from durable work units',
      )
    } else {
      // ── Fresh index: wipe stale units, extract, chunk.
      await deleteRagChunks(code)

      failedFiles = []
      workChunks = []
      totalChars = 0
      let idxBase = 0

      // The message body itself is indexable content — without this, text-only
      // sessions reported "ready" with an empty index and every query 500'd.
      if (session.text?.trim()) {
        const chunks = chunkPages('(session-message)', [{ page: null, text: session.text }], {
          targetChars: CONFIG.CHUNK_SIZE_CHARS,
          overlapChars: CONFIG.CHUNK_OVERLAP_CHARS,
        })
        for (const c of chunks) {
          workChunks.push({
            fileId: 'session-text',
            name: '(session-message)',
            page: c.page,
            idx: idxBase + c.idx,
            text: c.text,
          })
        }
        totalChars += session.text.length
        idxBase += chunks.length
        releaseMemory()
      }

      for (const f of session.files ?? []) {
        if (!isSupportedForExtraction(f.name, f.mimeType)) {
          failedFiles.push(f.name)
          continue
        }
        let buffer: Buffer | null = null
        try {
          buffer = await readGridFile(f.gridfsId)
          const doc = await extractFileText(f.name, f.mimeType, buffer)
          if (doc.error && doc.pages.length === 0) {
            failedFiles.push(f.name)
            continue
          }
          const chunks = chunkPages(f.name, doc.pages, {
            targetChars: CONFIG.CHUNK_SIZE_CHARS,
            overlapChars: CONFIG.CHUNK_OVERLAP_CHARS,
          })
          for (const c of chunks) {
            workChunks.push({
              fileId: f.gridfsId.toString(),
              name: f.name,
              page: c.page,
              idx: idxBase + c.idx,
              text: c.text,
            })
          }
          // NOTE: idx offset runs across files — per-file chunkers restart at
          // 0, and (code, idx) must stay globally unique or upserts collide.
          totalChars += doc.pages.reduce((n, p) => n + p.text.length, 0)
          idxBase += chunks.length
          // Drop references before the next file so peak memory stays flat.
          buffer = null as unknown as Buffer
          doc.pages.length = 0
          releaseMemory()
        } catch (err) {
          logger.warn({ code, file: f.name, err }, '[rag] per-file indexing error')
          failedFiles.push(f.name)
        }
      }
      releaseMemory()

      // Per-session chunk budget (pathological corpora) — even spread rather
      // than prefix so no whole document vanishes from the index.
      if (workChunks.length > CONFIG.MAX_CHUNKS_PER_SESSION) {
        const step = workChunks.length / CONFIG.MAX_CHUNKS_PER_SESSION
        workChunks = Array.from(
          { length: CONFIG.MAX_CHUNKS_PER_SESSION },
          (_, i) => workChunks[Math.floor(i * step)]
        )
        truncated = true
      }
    }

    if (workChunks.length === 0) {
      await StoredSession.updateOne({ code }, {
        $set: {
          aiStatus: 'ready',
          aiMode: 'direct',
          aiStats: {
            chunks: 0, files: 0, failedFiles,
            mode: 'direct', directChars: 0, fingerprint,
          },
        },
      })
      logger.info({ code }, '[rag] nothing indexable (text-less corpus)')
      return
    }

    // ── Workload analysis (§15–§18): route small corpora to direct stuffing.
    // (Fresh jobs only — resumed jobs keep the mode their units were
    // persisted under.)
    if (!plan) plan = planCorpus(totalChars, workChunks.length)

    // Persist canonical chunk docs FIRST (durable work units). Direct mode
    // completes them immediately with no vectors; vector mode leaves them
    // 'pending' until their batch lands in Mongo (§44 ordering).
    for (let i = 0; i < workChunks.length; i += MONGO_INSERT_BATCH) {
      const slice = workChunks.slice(i, i + MONGO_INSERT_BATCH)
      await RagChunk.collection.bulkWrite(
        slice.map(c => ({
          updateOne: {
            filter: { code, idx: c.idx },
            update: {
              $set: {
                code,
                fileId: c.fileId,
                name: c.name,
                page: c.page,
                text: c.text,
                st: plan.mode === 'direct' ? 'completed' : 'pending',
                gen: null,
              },
            },
            upsert: true,
          },
        })),
        { ordered: false }
      )
    }

    if (plan.mode === 'vector') {
      // Record the resume anchor BEFORE embedding starts (Bug fix): if the
      // process dies mid-job, recovery finds fingerprint+mode+chunk-count and
      // resumes from pending units instead of re-extracting everything.
      await StoredSession.updateOne({ code }, {
        $set: {
          aiStats: {
            chunks: workChunks.length,
            files: session.files.length - failedFiles.length,
            failedFiles,
            mode: 'vector',
            fingerprint,
          },
        },
      })
    }

    if (plan.mode === 'direct') {
      await finalizeReady(code, {
        mode: 'direct',
        chunks: workChunks.length,
        files: session.files.length - failedFiles.length,
        failedFiles,
        directChars: plan.totalChars,
        fingerprint,
      })
      logger.info(
        { code, chars: plan.totalChars, mode: 'direct', truncated },
        '[rag] session indexed (direct stuffing — no embeddings)',
      )
      return
    }

    // ── Vector path: embed in small durable batches via the orchestrator.
    let done = 0
    let servingGen: string | null = null
    for (let i = 0; i < workChunks.length; i += EMBED_BATCH) {
      const batch = workChunks.slice(i, i + EMBED_BATCH)
      const { vectors, generationId } = await embedWithFailover(batch.map(c => c.text))
      // Invariant 4 guard: a provider failover that CHANGES the embedding
      // space mid-job is a model switch (doc §34) — never mix silently.
      // Abort; durable completed batches keep their single generation and
      // recovery restarts the remainder under one consistent generation.
      if (servingGen && servingGen !== generationId) {
        throw new EmbeddingError(
          'provider',
          `embedding generation changed mid-job (${servingGen} → ${generationId})`,
        )
      }
      servingGen = generationId
      // Durable completion ordering (§44): persist vectors BEFORE counting
      // the batch complete; a crash here just leaves units pending.
      await RagChunk.collection.bulkWrite(
        batch.map((c, j) => ({
          updateOne: {
            filter: { code, idx: c.idx },
            update: { $set: { embedding: vectors[j], st: 'completed', gen: generationId } },
          },
        })),
        { ordered: false }
      )
      done += batch.length
      if ((done / EMBED_BATCH) % 8 === 0) releaseMemory() // every ~128 chunks
    }
    releaseMemory()
    logger.debug({ code, rssMb: Math.round(process.memoryUsage().rss / 1048576) }, '[rag] post-embed rss')

    // The DB is the source of truth for completion counts AND generation
    // identity (doc §44/Invariant 3) — derive both from persisted docs.
    const [persisted, gens] = await Promise.all([
      RagChunk.countDocuments({ code }),
      RagChunk.distinct('gen', { code, st: 'completed' }),
    ])
    if (gens.length !== 1 || !gens[0]) {
      throw new Error(`inconsistent index generations after embedding: ${gens.join(',')}`)
    }
    await finalizeReady(code, {
      mode: 'vector',
      chunks: persisted,
      files: session.files.length - failedFiles.length,
      failedFiles,
      gen: gens[0],
      fingerprint,
    })

    logger.info({
      code,
      chunks: persisted,
      files: session.files.length - failedFiles.length,
      failed: failedFiles.length,
      truncated,
      mode: 'vector',
    }, '[rag] session indexed')
  } catch (err) {
    if (err instanceof EmbeddingUnavailableError || err instanceof EmbeddingError) {
      // Provider/circuit exhaustion: NOT a corpus problem. Completed batches
      // stay durable; recovery re-kicks and resumes from pending units.
      logger.warn({ err, code }, '[rag] index paused — embedding providers unavailable')
    } else {
      logger.error({ err, code }, '[rag] index job failed')
    }
    await StoredSession.updateOne({ code }, { $set: { aiStatus: 'failed' } }).catch(() => {})
  }
}

async function finalizeReady(
  code: string,
  stats: {
    mode: 'direct' | 'vector'
    chunks: number
    files: number
    failedFiles: string[]
    gen?: string
    directChars?: number
    fingerprint?: string
  },
): Promise<void> {
  await StoredSession.updateOne({ code }, {
    $set: {
      aiStatus: 'ready',
      aiMode: stats.mode,
      aiStats: {
        chunks: stats.chunks,
        files: stats.files,
        failedFiles: stats.failedFiles,
        mode: stats.mode,
        ...(stats.gen ? { gen: stats.gen } : {}),
        ...(stats.directChars !== undefined ? { directChars: stats.directChars } : {}),
        ...(stats.fingerprint ? { fingerprint: stats.fingerprint } : {}),
      },
    },
  })
  // Fresh corpus → any cached in-memory search structures/answers are stale.
  dropSessionIndex(code)
}

/** Startup/periodic recovery: resume jobs that died or were paused mid-run.
 *  With durable work units a resume skips extraction/OCR/chunking entirely. */
export async function recoverPendingIndexes(): Promise<void> {
  if (!CONFIG.RAG_ENABLED || !CONFIG.MONGODB_URI) return
  try {
    const pending = await StoredSession.find({
      aiStatus: { $in: ['pending', 'failed'] },
      expiresAt: { $gt: new Date() },
    }).select('code').lean()
    for (const s of pending) {
      logger.info({ code: s.code }, '[rag] recovering index job')
      void indexSession(s.code)
    }
  } catch (err) {
    logger.error({ err }, '[rag] pending-index recovery failed')
  }
}
