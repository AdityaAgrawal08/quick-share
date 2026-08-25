import { pipeline, env } from '@huggingface/transformers'
import { CONFIG } from '../../config'
import logger from '../../logger'
import type { EmbeddingProvider } from './provider'

// ── Local BGE/ONNX provider (architecture doc §49) ──────────────────────────
// The guaranteed final fallback. bge-small-en-v1.5 → 384-dim normalized
// vectors. Model loads LAZILY on first embed (never at boot) so idle RSS on
// 512MB hosts stays low; direct-mode sessions never trigger a load at all.

env.allowLocalModels = false
if (process.env.HF_CACHE_DIR) env.cacheDir = process.env.HF_CACHE_DIR

interface FeatureExtractor {
  (texts: string[], opts?: { pooling?: string; normalize?: boolean }): Promise<{ tolist(): unknown }>
}

let extractorPromise: Promise<FeatureExtractor> | null = null

async function makeExtractor(): Promise<FeatureExtractor> {
  const start = Date.now()
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
