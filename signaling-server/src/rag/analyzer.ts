import { CONFIG } from '../config'

// ── Workload analyzer / corpus planner (architecture doc §15–§18) ───────────
// Cheap, post-extraction classification that decides HOW a session is indexed:
//
//  • 'direct' — total text ≤ DIRECT_STUFF_MAX_CHARS: skip chunk-embedding
//    entirely. At query time the FULL canonical content is stuffed into the
//    Groq prompt (128k-token window), so nothing is ever lost between chunks —
//    "near-perfect" retrieval by construction. The ONNX model never loads.
//
//  • 'vector' — larger corpora keep the hybrid BM25+cosine pipeline with the
//    local embedder as provider.
//
// File size alone is not complexity (doc §16): this runs on EXTRACTED chars,
// so scanned-PDF OCR cost and XLSX cell explosion are already reflected.

export type IndexMode = 'direct' | 'vector'

export interface CorpusPlan {
  mode: IndexMode
  totalChars: number
  chunkCount: number
}

export function planCorpus(totalChars: number, chunkCount: number): CorpusPlan {
  // Emergency kill switch for constrained hosts: force EVERY corpus through
  // direct stuffing so the ONNX embedder can never load (doc §53 fallback).
  if (CONFIG.RAG_FORCE_DIRECT) {
    return { mode: 'direct', totalChars, chunkCount }
  }
  const mode: IndexMode =
    totalChars > 0 && totalChars <= CONFIG.DIRECT_STUFF_MAX_CHARS ? 'direct' : 'vector'
  return { mode, totalChars, chunkCount }
}
