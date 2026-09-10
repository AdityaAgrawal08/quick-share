// Security regression tests — validates hardening items from security audit.
// Run: node --test tests/unit/security.test.mjs
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const dist = p => require(`../../dist/${p}`)

const { sanitiseFilename, sanitiseTextContent } = dist('security-utils.js')

// ── Item 5: sanitiseTextContent ─────────────────────────────────────────────

describe('sanitiseTextContent (Item 5)', () => {
  it('strips <script> tags with content', () => {
    assert.equal(sanitiseTextContent('hello<script>alert(1)</script>world'), 'helloworld')
  })

  it('strips self-closing <script/> tags', () => {
    assert.equal(sanitiseTextContent('a<script/>b'), 'ab')
  })

  it('strips event handlers (onerror, onclick, onload)', () => {
    const r1 = sanitiseTextContent('<img onerror="alert(1)" src="x">')
    assert.ok(!r1.includes('onerror'), `onerror should be stripped: ${r1}`)
    assert.ok(r1.includes('src="x"'), `src should remain: ${r1}`)

    const r2 = sanitiseTextContent('<div onclick=\'alert(1)\'>')
    assert.ok(!r2.includes('onclick'), `onclick should be stripped: ${r2}`)

    const r3 = sanitiseTextContent('<body onload = "hack()">')
    assert.ok(!r3.includes('onload'), `onload should be stripped: ${r3}`)
  })

  it('strips javascript: URIs', () => {
    assert.equal(sanitiseTextContent('click javascript:alert(1)'), 'click alert(1)')
    assert.equal(sanitiseTextContent('javascript :alert(1)'), 'alert(1)')
  })

  it('strips data: URIs (non-image)', () => {
    const r = sanitiseTextContent('data:text/html,<b>evil</b>')
    assert.ok(!r.includes('data:'), `data: URI should be stripped: ${r}`)
    // images are allowed
    assert.ok(sanitiseTextContent('<img src="data:image/png;base64,abc">').includes('data:image/png'))
  })

  it('strips VBScript URIs', () => {
    assert.equal(sanitiseTextContent('vbscript:MsgBox(1)'), 'MsgBox(1)')
  })

  it('strips <base> tag hijacking', () => {
    assert.equal(sanitiseTextContent('<base href="http://evil.com/">'), '')
  })

  it('strips <meta http-equiv="refresh"> redirect', () => {
    assert.equal(
      sanitiseTextContent('<meta http-equiv="refresh" content="0;url=evil.com">'),
      ''
    )
  })

  it('strips <iframe> tags with content', () => {
    assert.equal(sanitiseTextContent('<iframe src="evil.com"></iframe>'), '')
  })

  it('strips <object> tags with content', () => {
    assert.equal(sanitiseTextContent('<object data="evil.swf"></object>'), '')
  })

  it('strips <embed> tags', () => {
    assert.equal(sanitiseTextContent('<embed src="evil.swf">'), '')
  })

  it('strips <applet> tags with content', () => {
    assert.equal(sanitiseTextContent('<applet code="evil.class"></applet>'), '')
  })

  it('preserves safe content', () => {
    const safe = 'Hello world! This is <b>bold</b> and <a href="https://example.com">a link</a>.'
    assert.equal(sanitiseTextContent(safe), safe)
  })

  it('strips nested script tags', () => {
    const r = sanitiseTextContent('before<script><script>alert(1)</script></script>after')
    assert.ok(!r.includes('<script'), `nested script should be stripped: ${r}`)
    assert.ok(r.includes('before') && r.includes('after'), `surrounding text should remain: ${r}`)
  })

  it('handles empty input', () => {
    assert.equal(sanitiseTextContent(''), '')
  })
})

// ── Item 6: sanitiseFilename ────────────────────────────────────────────────

describe('sanitiseFilename (Item 6)', () => {
  it('strips path traversal (..)', () => {
    // basename of '../../etc/passwd' is 'passwd'; no '..' remains after split
    const r = sanitiseFilename('../../etc/passwd')
    assert.ok(!r.includes('..'), `double-dots should be stripped: ${r}`)
    assert.ok(r.length > 0, 'should not be empty')
  })

  it('strips null bytes', () => {
    assert.equal(sanitiseFilename('file\x00.txt'), 'file.txt')
  })

  it('strips control characters', () => {
    assert.equal(sanitiseFilename('file\x01\x02\x03.txt'), 'file.txt')
  })

  it('strips Windows-unsafe characters', () => {
    assert.equal(sanitiseFilename('file<>:"|?*.txt'), 'file.txt')
  })

  it('takes basename only (strips directory)', () => {
    assert.equal(sanitiseFilename('/path/to/file.txt'), 'file.txt')
  })

  it('truncates to 255 characters', () => {
    const long = 'a'.repeat(300)
    assert.equal(sanitiseFilename(long).length, 255)
  })

  it('returns "file" for empty/whitespace input', () => {
    assert.equal(sanitiseFilename(''), 'file')
    assert.equal(sanitiseFilename('   '), 'file')
    assert.equal(sanitiseFilename('\x00\x01'), 'file')
  })

  it('preserves safe filenames', () => {
    assert.equal(sanitiseFilename('document.pdf'), 'document.pdf')
    assert.equal(sanitiseFilename('my-file_v2.xlsx'), 'my-file_v2.xlsx')
  })
})

// ── Item 1: helmet security headers ────────────────────────────────────────

describe('helmet + security headers (Item 1)', () => {
  it('helmet is installed and importable', () => {
    const helmet = require('helmet')
    assert.equal(typeof helmet, 'function')
  })
})

// ── Item 15: Prometheus metrics ────────────────────────────────────────────

describe('prom-client metrics (Item 15)', () => {
  it('prom-client is installed and importable', () => {
    const client = require('prom-client')
    assert.equal(typeof client.Registry, 'function')
  })
})

// ── Session manager (P0-5: live session auth) ──────────────────────────────

describe('sessionManager (P0-5)', () => {
  const { createSession, getSession, activeSessions } = dist('sessionManager.js')

  it('createSession returns a 6-char hex code', () => {
    const code = createSession(60_000)
    assert.match(code, /^[0-9a-f]{6}$/)
  })

  it('getSession returns the session for a valid code', () => {
    const code = createSession(60_000)
    const sess = getSession(code)
    assert.ok(sess)
    assert.equal(sess.code, code)
  })

  it('getSession returns undefined for unknown code', () => {
    assert.equal(getSession('ffffff'), undefined)
  })

  it('activeSessions returns a number', () => {
    assert.equal(typeof activeSessions(), 'number')
  })
})

// ── WebSocket message rejection (Item 9) ───────────────────────────────────

describe('relay unknown message type rejection (Item 9)', () => {
  it('handleConnection is exported', () => {
    const { handleConnection } = dist('relay.js')
    assert.equal(typeof handleConnection, 'function')
  })
})

// ── Logger / securityLog (forensics) ───────────────────────────────────────

describe('securityLog (Item 7)', () => {
  it('securityLog is exported with expected methods', () => {
    const { securityLog } = dist('logger.js')
    assert.equal(typeof securityLog.token_invalid, 'function')
    assert.equal(typeof securityLog.burn_triggered, 'function')
    assert.equal(typeof securityLog.ai_quota_exceeded, 'function')
    assert.equal(typeof securityLog.upload_rejected, 'function')
  })
})

// ── Answer cache (P1-11 AI quota) ──────────────────────────────────────────

describe('answerCache', () => {
  const { getAnswer, putAnswer, clearAnswerCache, answerCacheSize } = dist('rag/answerCache.js')

  it('putAnswer/getAnswer round-trips', () => {
    putAnswer('code1', 'q1', { answer: 'a1', refused: false, sources: [] })
    const cached = getAnswer('code1', 'q1')
    assert.ok(cached)
    assert.equal(cached.answer, 'a1')
  })

  it('clearAnswerCache wipes a session', () => {
    putAnswer('code2', 'q1', { answer: 'a', refused: false, sources: [] })
    clearAnswerCache('code2')
    assert.equal(getAnswer('code2', 'q1'), undefined)
  })

  it('answerCacheSize returns a number', () => {
    assert.equal(typeof answerCacheSize(), 'number')
  })
})
