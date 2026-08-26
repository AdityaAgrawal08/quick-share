import type { ExtractedDoc } from '../types'
import type { WorkloadClass } from '../embedding/selector'

// ── File Analyzer (adaptive services ①) ─────────────────────────────────────
// Cheap post-extraction classification: consumes the file's metadata plus
// its ExtractedDoc (never re-reads the source) and produces everything the
// selector/router needs:
//
//   kind            pdf | docx | xlsx | text | image | unknown
//   requiresOcr     extracted text ~empty while pages exist ⇒ scanned/image
//   estimatedTokens conservative ceil(chars/3)
//   workload        low | medium | high | very_high  (drives model selection)
//
// File SIZE is never used alone (doc §16): a 200KB txt can out-work a 5MB
// scanned PDF only in byte terms — the score reflects EXTRACTED reality.

export interface AnalyzerInput {
  name: string
  mimeType: string
  sizeBytes: number
  doc: ExtractedDoc | null // null ⇒ unsupported/failed before extraction
}

export interface FileAnalysis {
  kind: 'pdf' | 'docx' | 'xlsx' | 'text' | 'image' | 'unknown'
  requiresOcr: boolean
  totalChars: number
  pageCount: number
  emptyPages: number
  estimatedTokens: number
  workload: WorkloadClass
  /** Human-readable note surfaced through aiStats when content was skipped. */
  notice?: string
}

function extOf(name: string): string {
  const i = name.lastIndexOf('.')
  return i >= 0 ? name.slice(i + 1).toLowerCase() : ''
}

export function analyzeFile(input: AnalyzerInput): FileAnalysis {
  const ext = extOf(input.name)
  let kind: FileAnalysis['kind'] = 'unknown'
  if (ext === 'pdf' || input.mimeType === 'application/pdf') kind = 'pdf'
  else if (['docx'].includes(ext) || input.mimeType.includes('wordprocessingml')) kind = 'docx'
  else if (['xlsx', 'xls', 'xlsm'].includes(ext) || input.mimeType.includes('spreadsheetml')) kind = 'xlsx'
  else if (input.mimeType.startsWith('image/') || ['png', 'jpg', 'jpeg', 'webp', 'bmp'].includes(ext)) kind = 'image'
  else kind = 'text'

  const pages = input.doc?.pages ?? []
  const totalChars = pages.reduce((n, p) => n + p.text.length, 0)
  const pageCount = pages.length
  const emptyPages = pages.filter(p => p.text.trim().length === 0).length

  // Scanned/OCR signal: pages exist but carry (almost) no text.
  const requiresOcr =
    kind === 'image' ||
    (pageCount > 0 && emptyPages > 0 && totalChars < pageCount * 40)

  const estimatedTokens = Math.ceil(totalChars / 3)

  let workload: WorkloadClass
  if (!requiresOcr && estimatedTokens <= 4_000) workload = 'low'
  else if (!requiresOcr && estimatedTokens <= 32_000) workload = 'medium'
  else if (!requiresOcr && estimatedTokens <= 120_000) workload = 'high'
  else workload = 'very_high'

  let notice: string | undefined
  if (kind === 'image' && !input.doc) {
    notice = 'Image file — enable RAG_OCR_ENABLED (on hosts with memory headroom) to extract text.'
  } else if (requiresOcr && kind === 'pdf') {
    notice = `PDF appears scanned (${emptyPages}/${pageCount} pages without text).`
  }

  return { kind, requiresOcr, totalChars, pageCount, emptyPages, estimatedTokens, workload, notice }
}
