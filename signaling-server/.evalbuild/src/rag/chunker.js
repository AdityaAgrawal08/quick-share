"use strict";
// ── Chunker ──────────────────────────────────────────────────────────────────
// PURE TypeScript — no Node/Browser APIs. Deliberately portable so the P2P
// client-side engine can reuse it verbatim.
//
// Strategy: paragraph-first packing with sentence fallback and character
// overlap between consecutive chunks. Each chunk is prefixed with its file
// name (+page) — short contextual boosts help both BM25 and embeddings.
Object.defineProperty(exports, "__esModule", { value: true });
exports.chunkPages = chunkPages;
const SENTENCE_RE = /(?<=[.!?。！？])\s+/;
function splitParagraphs(text) {
    return text.split(/\n{1,}/).map(s => s.trim()).filter(Boolean);
}
/** Greedy pack of units into ~target-sized windows; never splits a unit alone unless oversized. */
function packUnits(units, targetChars) {
    const out = [];
    let cur = [];
    let curLen = 0;
    const flush = () => {
        if (cur.length) {
            out.push(cur.join('\n'));
            cur = [];
            curLen = 0;
        }
    };
    for (const unit of units) {
        if (unit.length > targetChars) {
            // Oversized unit (giant paragraph): split by sentences.
            flush();
            const sentences = unit.split(SENTENCE_RE);
            let sCur = '';
            for (const s of sentences) {
                if (sCur && sCur.length + s.length + 1 > targetChars) {
                    out.push(sCur);
                    sCur = s;
                }
                else {
                    sCur = sCur ? `${sCur} ${s}` : s;
                }
            }
            if (sCur)
                out.push(sCur);
            continue;
        }
        if (curLen + unit.length + 1 > targetChars)
            flush();
        cur.push(unit);
        curLen += unit.length + 1;
    }
    flush();
    return out;
}
function withOverlap(windows, overlapChars) {
    if (overlapChars <= 0 || windows.length < 2)
        return windows;
    const result = [windows[0]];
    for (let i = 1; i < windows.length; i++) {
        const prev = windows[i - 1];
        const tail = prev.slice(-overlapChars);
        // Snap the tail to a word boundary so chunks don't start mid-word.
        const spaceAt = tail.indexOf(' ');
        const cleanTail = spaceAt !== -1 ? tail.slice(spaceAt + 1) : tail;
        result.push(`${cleanTail}\n${windows[i]}`);
    }
    return result;
}
/**
 * Convert extracted pages into retrieval chunks.
 * Chunks are numbered globally across the document (idx), preserving page metadata.
 */
function chunkPages(fileName, pages, opts = {}) {
    const targetChars = Math.max(200, opts.targetChars ?? 600);
    const overlapChars = Math.min(Math.max(0, opts.overlapChars ?? 90), Math.floor(targetChars / 3));
    const chunks = [];
    let idx = 0;
    for (const p of pages) {
        const paragraphs = splitParagraphs(p.text);
        if (paragraphs.length === 0)
            continue;
        // Context prefix helps retrieval ("in which file/page did X appear?").
        const prefix = p.page != null ? `[${fileName} · p.${p.page}]` : `[${fileName}]`;
        const budget = targetChars - prefix.length - 1;
        const windows = withOverlap(packUnits(paragraphs, budget), overlapChars);
        for (const w of windows) {
            const body = w.trim();
            if (!body)
                continue;
            chunks.push({ text: `${prefix} ${body}`, page: p.page, idx: idx++ });
        }
    }
    return chunks;
}
