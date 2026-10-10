import { embedWithFailover, ACTIVE_GENERATION_ID } from './embedding/orchestrator'
import { EmbeddingError } from './embedding/provider'

// ── Compat shim ──────────────────────────────────────────────────────────────
// Embedding flows through the orchestrator (rag/embedding/*). This module
// keeps the historical import surface (`embedTexts`, `embedQuery`,
// `ACTIVE_GENERATION`) alive for the eval harness and older call sites.

export const ACTIVE_GENERATION = ACTIVE_GENERATION_ID

export async function embedTexts(texts: string[]): Promise<number[][]> {
  const { vectors } = await embedWithFailover(texts)
  return vectors
}

export async function embedQuery(text: string): Promise<number[]> {
  const vectors = await embedTexts([text])
  const vec = vectors[0]
  // Guard the destructure: an empty provider response must throw a typed,
  // classifier-friendly error — not return `undefined` typed as number[].
  if (!vec || vec.length === 0) {
    throw new EmbeddingError('provider', 'embedTexts returned no vector for the query')
  }
  return vec
}
