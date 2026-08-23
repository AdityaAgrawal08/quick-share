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
import { embedTexts } from './embedder'
import type { Chunk } from './types'
import { dropSessionIndex } from './retriever'

// ── Index pipeline ───────────────────────────────────────────────────────────
// publish ──► indexSession(code)   (async, fire-and-forget, never blocks)
//
// Guarantees:
//  • Idempotent — always wipes existing chunks for the code first.
//  • One job per code at a time (in-flight map).
//  • Any failure flips aiStatus='failed'; nothing throws to the caller.

const EMBED_BATCH = 32
const MONGO_INSERT_BATCH = 100

const inFlight = new Map<string, Promise<void>>()

export function isIndexing(code: string): boolean {
  return inFlight.has(code)
}

export function indexSession(code: string): Promise<void> {
  const existing = inFlight.get(code)
  if (existing) return existing
  const job = runIndex(code).finally(() => inFlight.delete(code))
  inFlight.set(code, job)
  return job
}

async function runIndex(code: string): Promise<void> {
  try {
    await StoredSession.updateOne({ code }, { $set: { aiStatus: 'pending' } })
    await deleteRagChunks(code)

    const session = await StoredSession.findOne({ code }).select('+password').lean()
    if (!session) return // expired mid-flight; expiry cleanup handles chunks

    // Private (E2EE) sessions are NEVER indexed — defense-in-depth even if a
    // future call site forgets to check.
    if (session.password) {
      await StoredSession.updateOne({ code }, { $set: { aiStatus: 'none' } })
      logger.info({ code }, '[rag] skipping private session')
      return
    }

    // 1. Extract text per file (one bad file never kills the session index)
    const failedFiles: string[] = []
    const allChunks: Chunk[] = []

    // The message body itself is indexable content — without this, text-only
    // sessions reported "ready" with an empty index and every query 500'd.
    if (session.text?.trim()) {
      for (const c of chunkPages('(session-message)', [{ page: null, text: session.text }], {
        targetChars: CONFIG.CHUNK_SIZE_CHARS,
        overlapChars: CONFIG.CHUNK_OVERLAP_CHARS,
      })) {
        allChunks.push({
          fileId: 'session-text',
          name: '(session-message)',
          page: c.page,
          idx: c.idx,
          text: c.text,
        })
      }
    }

    for (const f of session.files ?? []) {
      if (!isSupportedForExtraction(f.name, f.mimeType)) {
        failedFiles.push(f.name)
        continue
      }
      try {
        const buffer = await readGridFile(f.gridfsId)
        const doc = await extractFileText(f.name, f.mimeType, buffer)
        if (doc.error && doc.pages.length === 0) {
          failedFiles.push(f.name)
          continue
        }
        for (const c of chunkPages(f.name, doc.pages, {
          targetChars: CONFIG.CHUNK_SIZE_CHARS,
          overlapChars: CONFIG.CHUNK_OVERLAP_CHARS,
        })) {
          allChunks.push({
            fileId: f.gridfsId.toString(),
            name: f.name,
            page: c.page,
            idx: c.idx,
            text: c.text,
          })
        }
      } catch (err) {
        logger.warn({ code, file: f.name, err }, '[rag] per-file indexing error')
        failedFiles.push(f.name)
      }
    }

    // 2. Enforce per-session chunk budget (pathological corpora)
    let truncated = false
    let workChunks = allChunks
    if (allChunks.length > CONFIG.MAX_CHUNKS_PER_SESSION) {
      // Keep an even spread across the document set rather than a prefix.
      const step = allChunks.length / CONFIG.MAX_CHUNKS_PER_SESSION
      workChunks = Array.from(
        { length: CONFIG.MAX_CHUNKS_PER_SESSION },
        (_, i) => allChunks[Math.floor(i * step)]
      )
      truncated = true
    }

    if (workChunks.length === 0) {
      await StoredSession.updateOne({ code }, {
        $set: { aiStatus: 'ready', aiStats: { chunks: 0, files: 0, failedFiles } },
      })
      logger.info({ code }, '[rag] nothing indexable (text-less corpus)')
      return
    }

    // 3. Embed in batches
    const embeddings: number[][] = []
    for (let i = 0; i < workChunks.length; i += EMBED_BATCH) {
      const batch = workChunks.slice(i, i + EMBED_BATCH).map(c => c.text)
      embeddings.push(...await embedTexts(batch))
    }

    // 4. Persist in batches
    for (let i = 0; i < workChunks.length; i += MONGO_INSERT_BATCH) {
      const slice = workChunks.slice(i, i + MONGO_INSERT_BATCH)
      // Native-collection bulkWrite: the mongoose-model insertMany path
      // silently dropped documents when running under ts-node-dev.
      const docs = slice.map((c, j) => ({
        code,
        fileId: c.fileId,
        name: c.name,
        page: c.page,
        idx: c.idx,
        text: c.text,
        embedding: embeddings[i + j],
      }))
      await RagChunk.collection.bulkWrite(
        docs.map(d => ({
          replaceOne: {
            filter: { code: d.code, idx: d.idx },
            replacement: d,
            upsert: true,
          },
        })),
        { ordered: false }
      )
    }

    await StoredSession.updateOne({ code }, {
      $set: {
        aiStatus: 'ready',
        aiStats: { chunks: workChunks.length, files: session.files.length - failedFiles.length, failedFiles },
      },
    })
    // Fresh corpus → any cached in-memory search structures/answers are stale.
    dropSessionIndex(code)

    logger.info({
      code,
      chunks: workChunks.length,
      files: session.files.length - failedFiles.length,
      failed: failedFiles.length,
      truncated,
    }, '[rag] session indexed')
  } catch (err) {
    logger.error({ err, code }, '[rag] index job failed')
    await StoredSession.updateOne({ code }, { $set: { aiStatus: 'failed' } }).catch(() => {})
  }
}

/** Startup/periodic recovery: re-kick jobs that died mid-run. */
export async function recoverPendingIndexes(): Promise<void> {
  if (!CONFIG.RAG_ENABLED || !CONFIG.MONGODB_URI) return
  try {
    const pending = await StoredSession.find({
      aiStatus: 'pending',
      expiresAt: { $gt: new Date() },
    }).select('code').lean()
    for (const s of pending) {
      logger.info({ code: s.code }, '[rag] recovering pending index job')
      void indexSession(s.code)
    }
  } catch (err) {
    logger.error({ err }, '[rag] pending-index recovery failed')
  }
}
