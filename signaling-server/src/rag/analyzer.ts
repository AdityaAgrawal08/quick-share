import { CONFIG } from '../config'

// ── Workload analyzer / corpus planner (architecture doc §15–§18) ───────────
// Cheap, post-extraction classification that decides HOW a session is indexed:
//
//  • 'direct' — estimated tokens ≤ DIRECT_STUFF_MAX_TOKENS (derived from the
//    ACTIVE Groq model's context window): skip chunk-embedding entirely. At
//    query time the FULL canonical content is stuffed into the prompt, so
//    nothing is lost between chunks — near-perfect retrieval by construction.
//    The ONNX model never loads.
//
//  • 'vector' — larger corpora keep the hybrid BM25+cosine pipeline.
//
// Token estimation is deliberately CONSERVATIVE (3 chars/token ⇒ we count
// HIGH): under-stuffing is safe, overflowing the LLM context is not
// (review §4). Extracted chars are the input — never file size — so OCR-heavy
// PDFs and XLSX cell explosion are already reflected in the totals.

export type IndexMode = 'direct' | 'vector'

export interface CorpusPlan {
  mode: IndexMode
  totalChars: number
  chunkCount: number
  /** Conservative token estimate: ceil(chars / 3). */
  estimatedTokens: number
}

/** Conservative chars→tokens estimate (3 chars per token ⇒ high count). */
export function estimateTokens(chars: number): number {
  return Math.ceil(chars / 3)
}

export function planCorpus(totalChars: number, chunkCount: number): CorpusPlan {
  const estimatedTokens = estimateTokens(totalChars)
  // Emergency kill switch for constrained hosts: force EVERY corpus through
  // direct stuffing so the ONNX embedder can never load (doc §53 fallback).
  if (CONFIG.RAG_FORCE_DIRECT) {
    return { mode: 'direct', totalChars, chunkCount, estimatedTokens }
  }
  const fitsContext = totalChars > 0 && estimatedTokens <= CONFIG.DIRECT_STUFF_MAX_TOKENS
  const mode: IndexMode = fitsContext ? 'direct' : 'vector'
  return { mode, totalChars, chunkCount, estimatedTokens }
}
