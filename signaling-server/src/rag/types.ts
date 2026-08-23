// ── RAG shared contracts ─────────────────────────────────────────────────────
// Pure types only — this file must stay importable from any runtime
// (Node server today, browser client for the P2P follow-up).

/** A single extracted page of text from a source file. */
export interface ExtractedPage {
  /** 1-based page/sheet index where meaningful; null for single-body docs. */
  page: number | null
  text: string
}

export interface ExtractedDoc {
  pages: ExtractedPage[]
  /** Files we could not read are skipped, never fatal to indexing. */
  error?: string
}

export interface ChunkMeta {
  fileId: string
  name: string
  page: number | null
  idx: number
}

export interface Chunk extends ChunkMeta {
  text: string
}

export interface EmbeddedChunk extends Chunk {
  embedding: number[]
}

/** A retrieved chunk handed to the LLM and shown as a citation. */
export interface Source {
  name: string
  fileId: string
  page: number | null
  score: number
  snippet: string
}
