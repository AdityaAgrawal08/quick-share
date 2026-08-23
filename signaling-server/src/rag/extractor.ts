import { extractText, getDocumentProxy } from 'unpdf'
import mammoth from 'mammoth'
import * as XLSX from 'xlsx'
import logger from '../logger'
import type { ExtractedDoc, ExtractedPage } from './types'

// ── Text extraction ──────────────────────────────────────────────────────────
// Dispatches on MIME type / extension and returns page-structured text.
// Scope note (v1): images and scanned PDFs are NOT OCR'd — a file with no
// text layer yields an empty doc, which the pipeline reports honestly.
//
// Every extractor is wrapped so one bad file can never fail the whole
// session index — the caller records per-file errors instead.

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
  return mimeType.startsWith('text/')
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
    return { pages: [], error: `unsupported type: ${mimeType || ext || 'unknown'}` }
  } catch (err) {
    logger.warn({ name, mimeType, err }, '[rag] extraction failed for file')
    return { pages: [], error: err instanceof Error ? err.message : 'extraction failed' }
  }
}
