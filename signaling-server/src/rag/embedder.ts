import { pipeline, env } from '@huggingface/transformers'
import { CONFIG } from '../config'
import logger from '../logger'

// ── Embeddings (local CPU via ONNX) ──────────────────────────────────────────
// bge-small-en-v1.5 → 384-dim normalized vectors. Model weights (~25MB q8)
// download once to disk cache on first use, then load from disk.
//
// Singleton with in-flight dedup: concurrent index jobs share one pipeline.
// A failure here must NEVER crash the process — callers convert rejections
// into session aiStatus='failed'.

env.allowLocalModels = false

// The concrete pipeline type from transformers.js is unwieldy; feature-
// extraction call signature: (texts, opts) → Tensor with .tolist().
interface FeatureExtractor {
  (texts: string[], opts?: { pooling?: string; normalize?: boolean }): Promise<{ tolist(): unknown }>
}

let extractorPromise: Promise<FeatureExtractor> | null = null

async function makeExtractor(): Promise<FeatureExtractor> {
  const start = Date.now()
  const pipe = await pipeline('feature-extraction', CONFIG.EMBED_MODEL, {
    dtype: 'q8',
  }) as unknown as FeatureExtractor
  logger.info({ ms: Date.now() - start, model: CONFIG.EMBED_MODEL }, '[rag] embedder loaded')
  return pipe
}

export function getEmbedder(): Promise<FeatureExtractor> {
  if (!extractorPromise) {
    extractorPromise = makeExtractor().catch((err: unknown) => {
      extractorPromise = null // allow retry on next call
      throw err
    })
  }
  return extractorPromise
}

/** Embed a batch of texts into normalized vectors. */
export async function embedTexts(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return []
  const extractor = await getEmbedder()
  const output = await extractor(texts, { pooling: 'mean', normalize: true })
  return output.tolist() as number[][]
}

export async function embedQuery(text: string): Promise<number[]> {
  // Chunker already prefixes file/page context; plain symmetric encoding
  // works well with bge-small v1.5 for this corpus shape.
  const [vec] = await embedTexts([text])
  return vec
}

export async function preloadEmbedder(): Promise<void> {
  try {
    await getEmbedder()
  } catch (err) {
    logger.error({ err }, '[rag] embedder preload failed — will retry on first use')
  }
}
