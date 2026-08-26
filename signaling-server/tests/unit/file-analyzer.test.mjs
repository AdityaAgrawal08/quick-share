// Unit tests — file analyzer classification (adaptive services P2).
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const dist = p => require(`../../dist/${p}`)
const { analyzeFile } = dist('rag/analyzer/file-analyzer.js')

const mk = (pages, meta = {}) => ({
  name: 'f',
  mimeType: 'text/plain',
  sizeBytes: 1000,
  doc: { pages, error: undefined },
  ...meta,
})

describe('analyzeFile', () => {
  it('classifies by extension/mime', () => {
    assert.equal(analyzeFile({ ...mk([]), name: 'a.pdf', mimeType: 'application/pdf' }).kind, 'pdf')
    assert.equal(analyzeFile({ ...mk([]), name: 'b.docx', mimeType: '' }).kind, 'docx')
    assert.equal(analyzeFile({ ...mk([]), name: 'c.xlsx', mimeType: '' }).kind, 'xlsx')
    assert.equal(analyzeFile({ ...mk([]), name: 'd.png', mimeType: 'image/png' }).kind, 'image')
    assert.equal(analyzeFile(mk([{ page: null, text: 'hi' }])).kind, 'text')
  })

  it('flags scanned PDFs (pages exist, no text)', () => {
    const a = analyzeFile({
      name: 'scan.pdf', mimeType: 'application/pdf', sizeBytes: 5e6,
      doc: { pages: [{ page: 1, text: '' }, { page: 2, text: '' }, { page: 3, text: '' }] },
    })
    assert.equal(a.requiresOcr, true)
    assert.match(a.notice ?? '', /scanned/)
    assert.equal(a.workload, 'very_high')
  })

  it('marks image kind as OCR-requiring with actionable notice', () => {
    const a = analyzeFile({ name: 'p.png', mimeType: 'image/png', sizeBytes: 1e6, doc: null })
    assert.equal(a.kind, 'image')
    assert.equal(a.requiresOcr, true)
    assert.match(a.notice ?? '', /RAG_OCR_ENABLED/)
  })

  it('workload tiers scale with extracted tokens', () => {
    const t = chars => analyzeFile(mk([{ page: null, text: 'x'.repeat(chars) }])).workload
    assert.equal(t(3_000), 'low')
    assert.equal(t(30_000), 'medium')
    assert.equal(t(300_000), 'high')
    assert.equal(t(500_000), 'very_high')
  })

  it('conservative token estimate is ceil(chars/3)', () => {
    const a = analyzeFile(mk([{ page: null, text: 'ab'.repeat(1500) }])) // 3000 chars
    assert.equal(a.estimatedTokens, 1000)
  })
})
