import { embedWithFailover, ACTIVE_GENERATION_ID } from './embedding/orchestrator'

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
  const [vec] = await embedTexts([text])
  return vec
}
