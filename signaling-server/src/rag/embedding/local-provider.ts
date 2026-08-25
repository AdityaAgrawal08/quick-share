import { CONFIG } from '../../config'
import logger from '../../logger'
import type { EmbeddingProvider } from './provider'
import { detectMemoryProfile } from '../memory-profile'

// ── Local BGE/ONNX provider (architecture doc §49) ──────────────────────────
// The guaranteed final fallback. bge-small-en-v1.5 → 384-dim normalized
// vectors.
//
// RAM discipline:
//  • transformers.js + onnxruntime-node are imported LAZILY inside makeExtractor()
//    — a static import would map native libs (~40-80MB RSS) even on hosts that
//    never embed (review: TINY hosts must stay flat without keys).
//  • Loading is refused outright when the detected memory profile forbids it
//    (TINY without explicit RAG_ALLOW_LOCAL_TINY=true) — fail-closed before
//    any allocation, not after.

interface FeatureExtractor {
  (texts: string[], opts?: { pooling?: string; normalize?: boolean }): Promise<{ tolist(): unknown }>
}

let extractorPromise: Promise<FeatureExtractor> | null = null

async function makeExtractor(): Promise<FeatureExtractor> {
  const profile = detectMemoryProfile()
  if (!profile.localEmbedderAllowed) {
    throw new Error(
      `local embedder not permitted on this host (tier=${profile.tier}, limit=${profile.limitMb}MB). ` +
        'Use an API embedding provider or set RAG_ALLOW_LOCAL_TINY=true deliberately.',
    )
  }
  const start = Date.now()
  const { pipeline, env } = await import('@huggingface/transformers')
  env.allowLocalModels = false
  if (process.env.HF_CACHE_DIR) env.cacheDir = process.env.HF_CACHE_DIR
  const pipe = await pipeline('feature-extraction', CONFIG.EMBED_MODEL, {
    dtype: CONFIG.EMBED_DTYPE as 'q8' | 'fp32' | 'fp16',
  }) as unknown as FeatureExtractor
  logger.info({ ms: Date.now() - start, model: CONFIG.EMBED_MODEL }, '[rag] embedder loaded')
  return pipe
}

function getExtractor(): Promise<FeatureExtractor> {
  if (!extractorPromise) {
    extractorPromise = makeExtractor().catch((err: unknown) => {
      extractorPromise = null // allow retry on next call
      throw err
    })
  }
  return extractorPromise
}

export const ACTIVE_GENERATION = `local:${CONFIG.EMBED_MODEL}`

class LocalBgeProvider implements EmbeddingProvider {
  readonly id = 'local-bge'
  readonly generationId = ACTIVE_GENERATION

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return []
    // Small batches keep ORT activation memory bounded (doc §46).
    const extractor = await getExtractor()
    const output = await extractor(texts, { pooling: 'mean', normalize: true })
    return output.tolist() as number[][]
  }
}

let localProvider: EmbeddingProvider | null = null

export function getLocalProvider(): EmbeddingProvider {
  if (!localProvider) localProvider = new LocalBgeProvider()
  return localProvider
}
