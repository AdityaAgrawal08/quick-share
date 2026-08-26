import { extractText, getDocumentProxy } from 'unpdf'
import mammoth from 'mammoth'
import * as XLSX from 'xlsx'
import logger from '../logger'
import { CONFIG } from '../config'
import { detectMemoryProfile } from './memory-profile'
import type { ExtractedDoc, ExtractedPage } from './types'

// ── Text extraction ──────────────────────────────────────────────────────────
// Dispatches on MIME type / extension and returns page-structured text.
// Image files are OCR'd via tesseract.js when RAG_OCR_ENABLED is set — and
// only on hosts whose memory profile allows it (the WASM runtime allocates
// 120–200MB transiently, so TINY tiers keep this off: review §5). Scanned
// PDFs (image-only pages) are DETECTED but not rasterized — unpdf has no
// renderer; the pipeline surfaces an honest notice instead.
//
// Every extractor is wrapped so one bad file can never fail the whole
// session index — the caller records per-file errors instead.

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'webp', 'bmp'])

const TEXT_EXTENSIONS = new Set([
  'txt', 'md', 'markdown', 'json', 'xml', 'yml', 'yaml', 'csv', 'log',
  'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'py', 'rb', 'go', 'rs', 'java',
  'c', 'h', 'cpp', 'hpp', 'cs', 'php', 'sh', 'sql', 'html', 'css', 'toml',
  'ini', 'env', 'srt', 'vtt',
])

function extOf(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot === -1 ? '' : name.slice(dot + 1).toLowerCase()
}

export function isSupportedForExtraction(name: string, mimeType: string): boolean {
  const ext = extOf(name)
  if (ext === 'pdf' || mimeType === 'application/pdf') return true
  if (['docx'].includes(ext) || mimeType.includes('wordprocessingml')) return true
  if (['xlsx', 'xls', 'xlsm'].includes(ext) || mimeType.includes('spreadsheetml') || mimeType === 'application/vnd.ms-excel') return true
  if (TEXT_EXTENSIONS.has(ext)) return true
  if (mimeType.startsWith('text/')) return true
  if (
    CONFIG.RAG_OCR_ENABLED &&
    detectMemoryProfile().workloadCeilingMb >= 300 && // OCR needs real headroom
    (mimeType.startsWith('image/') || IMAGE_EXTENSIONS.has(ext))
  ) {
    return true
  }
  return false
}

/** OCR a single image buffer via tesseract.js (lazy import, RSS-guarded). */
async function extractImageOcr(buffer: Buffer): Promise<ExtractedDoc> {
  const profile = detectMemoryProfile()
  if (!CONFIG.RAG_OCR_ENABLED || profile.workloadCeilingMb < 300) {
    throw new Error('ocr_disabled_for_host')
  }
  if (buffer.length > CONFIG.RAG_OCR_MAX_BYTES) {
    throw new Error(`ocr_input_too_large:${buffer.length}`)
  }
  const rssMb = process.memoryUsage().rss / 1048576
  if (rssMb + 200 > profile.workloadCeilingMb) {
    throw new Error(`ocr_rss_headroom_exceeded:${Math.round(rssMb)}MB`)
  }
  const start = Date.now()
  const { createWorker } = await import('tesseract.js')
  const worker = await createWorker(CONFIG.RAG_OCR_LANG)
  try {
    const { data } = await worker.recognize(buffer)
    logger.info({ ms: Date.now() - start, chars: data.text.length }, '[rag] ocr image extracted')
    return {
      pages: [{ page: 1, text: (data.text ?? '').trim() }],
      ...(data.text ? {} : { error: 'ocr_empty_result' }),
    }
  } finally {
    await worker.terminate().catch(() => {})
  }
}

async function extractPdf(buffer: Buffer): Promise<ExtractedDoc> {
  const pdf = await getDocumentProxy(new Uint8Array(buffer))
  const { text } = await extractText(pdf, { mergePages: false })
  // unpdf returns one string per page; normalise whitespace per page.
  const pages: ExtractedPage[] = (Array.isArray(text) ? text : [text])
    .map((t, i) => ({ page: i + 1, text: t.replace(/\s+\n/g, '\n').trim() }))
    .filter(p => p.text.length > 0)
  return { pages }
}

async function extractDocx(buffer: Buffer): Promise<ExtractedDoc> {
  const { value } = await mammoth.extractRawText({ buffer })
  const text = value.trim()
  if (!text) return { pages: [] }
  // DOCX has no reliable page boundaries — treat as one body, null page.
  return { pages: [{ page: null, text }] }
}

function sheetToText(sheet: XLSX.WorkSheet): string {
  const csv = XLSX.utils.sheet_to_csv(sheet, { blankrows: false })
  // Cap pathological sheets; a single sheet producing megabytes of CSV is
  // noise for retrieval, not signal.
  return csv.length > 500_000 ? csv.slice(0, 500_000) + '\n…[truncated]' : csv
}

async function extractXlsx(buffer: Buffer): Promise<ExtractedDoc> {
  const wb = XLSX.read(buffer, { type: 'buffer' })
  const pages: ExtractedPage[] = []
  wb.SheetNames.forEach((sheetName, i) => {
    const text = `${sheetName}\n${sheetToText(wb.Sheets[sheetName])}`.trim()
    if (text !== sheetName) pages.push({ page: i + 1, text })
  })
  return { pages }
}

function extractPlainText(buffer: Buffer): ExtractedDoc {
  const text = buffer.toString('utf8').replace(/\u0000/g, '').trim()
  return text ? { pages: [{ page: null, text }] } : { pages: [] }
}

export async function extractFileText(name: string, mimeType: string, buffer: Buffer): Promise<ExtractedDoc> {
  const ext = extOf(name)
  try {
    if (ext === 'pdf' || mimeType === 'application/pdf') return await extractPdf(buffer)
    if (ext === 'docx' || mimeType.includes('wordprocessingml')) return await extractDocx(buffer)
    if (['xlsx', 'xls', 'xlsm'].includes(ext) || mimeType.includes('spreadsheetml')) return await extractXlsx(buffer)
    if (TEXT_EXTENSIONS.has(ext) || mimeType.startsWith('text/')) return extractPlainText(buffer)
    if (mimeType.startsWith('image/') || IMAGE_EXTENSIONS.has(ext)) return await extractImageOcr(buffer)
    return { pages: [], error: `unsupported type: ${mimeType || ext || 'unknown'}` }
  } catch (err) {
    logger.warn({ name, mimeType, err }, '[rag] extraction failed for file')
    return { pages: [], error: err instanceof Error ? err.message : 'extraction failed' }
  }
}
