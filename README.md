# QuickShare

[![CI](https://github.com/AdityaAgrawal08/quick-share/actions/workflows/ci.yml/badge.svg)](https://github.com/AdityaAgrawal08/quick-share/actions/workflows/ci.yml)

A modern file and text sharing platform with **WebRTC peer-to-peer transfers**, **MongoDB GridFS persistence**, end-to-end encrypted **Private mode**, and a built-in **RAG AI agent** that answers questions about shared content with grounded, cited responses.

---

## Features

### Sharing

- **Peer-to-Peer (WebRTC):** Direct browser-to-browser file transfer with no size cap. The server only relays signaling — it never sees P2P content.
- **Persistent Sessions (GridFS):** Files and text stored in MongoDB (up to 10MB). Open sessions are AI-indexable; Private sessions use client-side AES-256-GCM encryption — the server stores ciphertext only.
- **Burn-on-Read:** One-time sessions that self-destruct after the recipient's grace window.
- **NAT Traversal:** Metered.ca STUN/TURN fallback for reliable connectivity behind NATs and firewalls.

### AI Agent

- **RAG Pipeline:** Text extraction (PDF, DOCX, XLSX, code) → chunking → embeddings (ONNX `bge-small`) → hybrid BM25 + vector search → optional cross-encoder rerank → Groq LLM with inline citations and anti-hallucination refusal.
- **Memory-Aware:** Automatically detects host memory and adapts — from full-content stuffing on tiny instances to vector search with reranking on large ones.
- **Degraded Mode:** When embedding providers are unavailable, falls back to BM25 keyword search instead of failing.

### Security

- **Authentication:** 6-digit code serves as a human-friendly identifier; a separate 32-char join token grants access to stored sessions. Live WebRTC sessions use password-gated WebSocket joins with server-assigned roles.
- **Input Sanitization:** User-supplied text is stripped of script tags, event handlers, `javascript:` URIs, `<iframe>`, `<object>`, `<embed>`, and `<meta refresh>` redirects. Filenames are sanitized against path traversal and control characters.
- **Security Headers:** HSTS, CSP with per-request nonces, X-Frame-Options, X-Content-Type-Options, Referrer-Policy, X-DNS-Prefetch-Control, and Cross-Origin-Resource-Policy — all via `helmet`.
- **Rate Limiting:** Per-IP and per-endpoint rate limiters with `retryAfter` headers. Upload bandwidth capped at 500 MB/hour globally.
- **Resource Limits:** WebSocket connections capped per IP (default 20). Request timeout enforced (30s). Memory pressure monitoring with load shedding on expensive endpoints.
- **Observability:** X-Request-ID tracing, structured security event logging, Prometheus `/metrics` endpoint, CSP violation reporting at `/csp-report`.
- **Privacy:** `/robots.txt` blocks indexing. `/.well-known/security.txt` provides contact information. `Cache-Control: no-store` on all sensitive endpoints.

### UI

- React + Vite, dark/light theme, QR pairing, live transfer progress, streaming chat drawer with source chips.

---

## Architecture

```mermaid
graph TD
    A([Browser]) <-->|WebSocket signaling| S[Node.js backend :3002]
    B([Browser]) <-->|WebRTC P2P data| A
    A -->|Open upload ≤10MB| S
    S --> M[(Atlas MongoDB + GridFS)]
    subgraph RAG pipeline [RAG pipeline - server side]
        S --> E[Extract PDF/DOCX/XLSX/text]
        E --> C[Chunk] --> EM[Embed bge-small ONNX]
        EM --> RC[(ragchunks)]
    end
    Q[Question] --> H[Hybrid BM25 + cosine -> RRF -> rerank opt-in]
    H --> G[Groq LLM - cited grounded answers]
```

Workspaces:
1. **`client`** — React/Vite SPA
2. **`signaling-server`** — Express + ws + Mongoose backend (`src/rag/` holds the AI pipeline)

---

## Local Setup

### Prerequisites

**Node.js v20+**

### Backend

```bash
cd signaling-server
npm install
```

Create `.env` (never committed):

```env
PORT=3002
MONGODB_URI=your_mongodb_atlas_uri
ALLOWED_ORIGINS=http://localhost:4000,https://your-production-domain
METERED_API_KEY=optional_metered_key
GROQ_API_KEY=gsk_your_free_groq_key
GROQ_MODEL=openai/gpt-oss-120b
NODE_ENV=development
```

> Free Groq key: [console.groq.com/keys](https://console.groq.com/keys) — no credit card required. Without it, the app works in **retrieval-only mode**: indexing and search function normally, but final AI answers are disabled.

```bash
npm run dev     # ts-node-dev on :3002
```

First run downloads ~90MB of ONNX models (embedder), then serves from disk cache.

### Frontend

```bash
cd ../client
npm install
```

Create `.env`:

```env
VITE_API_URL=http://localhost:3002
```

```bash
npm run dev     # pinned to http://localhost:4000
```

> Client port is fixed at 4000 so the origin always matches backend `ALLOWED_ORIGINS`. Change both together if needed.

---

## Using the AI Agent

1. Publish an **Open** session (no password) — indexing starts automatically.
2. Recipient opens the join link/code → content renders → **"Ask about these files"** drawer appears.
3. Ask anything: *"Summarise this"*, *"What's the oil change interval?"* → streamed answer with source citations.
4. Questions outside the corpus get an honest refusal — no hallucinations.
5. **Private** sessions show "AI features are off." — encryption means the server cannot read them.

Rate limits: 10 queries / 15 min / IP, 50 queries / 24h / session, 200 queries / hour globally.

### Retrieval Quality Gate

```bash
cd signaling-server && npx tsc --module nodenext --moduleResolution nodenext \
  --target es2022 --skipLibCheck --strict false --outDir .evalbuild \
  scripts/rag-eval.mts src/rag/embedder.ts src/rag/chunker.ts src/rag/types.ts
node .evalbuild/scripts/rag-eval.mjs   # expect hit@3 >= 0.90
rm -rf .evalbuild
```

---

## Adaptive AI Services

The AI layer detects host memory at boot and adapts automatically:

| Tier | Memory | Behavior |
|---|---|---|
| **Tiny** | <768 MB | Local ONNX embedder excluded. Small/medium corpora use full-content stuffing; large ones use BM25 keywords. |
| **Standard** | 768–2048 MB | API-first embeddings, local BGE fallback, image OCR allowed. |
| **Large** | >2048 MB | Cross-encoder reranker eligible. |

### Provider Fallback

```text
1. Direct stuffing      corpus fits the Groq window (~75% of context tokens)
2. Embedding providers  Cohere → Voyage → local BGE   (circuit breakers,
                        quota cooldowns, health-aware ordering per call)
3. BM25 keyword mode    every provider down → session still answers
```

### Provider Keys (all optional)

`COHERE_API_KEY` · `VOYAGE_API_KEY` — registry order via `RAG_PROVIDER_ORDER` (default `cohere,voyage,local`). Health monitor snapshots breaker states to MongoDB every 60 seconds.

### Content Analysis and OCR

Every upload is classified by kind, scanned-page ratio, token estimate, and workload tier. Image files are OCR'd via tesseract.js only when `RAG_OCR_ENABLED=true` and the host has sufficient memory.

---

## Production Deployment

### Frontend (Cloudflare Pages)

| Setting | Value |
|---|---|
| Preset | Vite |
| Root Directory | `client` |
| Build Command | `npm run build` |
| Output Directory | `dist` |
| Env var | `VITE_API_URL=https://<your-backend-host>` |

### Backend (Render free tier proven)

| Setting | Value |
|---|---|
| Root Directory | `signaling-server` |
| Build Command | `npm run build` |
| Start Command | `npm start` |

### Environment Variables

| Variable | Purpose | Default |
|---|---|---|
| `MONGODB_URI` | Atlas connection string | — |
| `ALLOWED_ORIGINS` | Comma-separated frontend origins | — |
| `NODE_ENV` | `production` | — |
| `GROQ_API_KEY` | Enables AI answers | — |
| `GROQ_MODEL` | LLM model | `openai/gpt-oss-120b` |
| `RAG_RERANK_ENABLED` | Cross-encoder reranking | unset on 512MB tiers |
| `RAG_DIRECT_STUFF_CHARS` | Skip embeddings below this char count | `48000` |
| `RAG_RESUME_ENABLED` | Resume indexing after crash | `true` |
| `RAG_BREAKER_THRESHOLD` / `RAG_BREAKER_COOLDOWN_MS` | Circuit breaker tuning | `3` / `30000` |
| `RAG_EMBED_MODEL` / `RAG_EMBED_DTYPE` | Local embedder + quantization | `Xenova/bge-small-en-v1.5` / `q8` |
| `RAG_MAX_CHUNKS` / `RAG_CHUNK_SIZE` / `RAG_CHUNK_OVERLAP` / `RAG_EMBED_BATCH` | Indexing tuning | `4000` / `600` / `90` / `16` |
| `NODE_OPTIONS` | Recommended: `--max-old-space-size=384` | — |
| `AI_GLOBAL_BUDGET` | Global AI queries per hour | `200` |
| `SESSION_GLOBAL_LIMIT` | Session creations per hour | `100` |
| `UPLOAD_GLOBAL_CAP_MB` | Upload bandwidth cap (MB/hour) | `500` |
| `WS_MAX_PER_IP` | WebSocket connections per IP | `20` |
| `REQUEST_TIMEOUT_MS` | Request timeout | `30000` |
| `MEMORY_THRESHOLD_MB` | Memory pressure threshold | `450` |

> ONNX weights (~25MB) download lazily on first vector-mode index only. Sessions indexed before an embedder-model change self-heal: the first AI query returns `202 indexing` while the index rebuilds.

---

## API Reference

| Endpoint | Description |
|---|---|
| `POST /publish` | Upload files/text. No password = open session; password = private/E2EE. |
| `PATCH /publish/:code?k=<token>` | Update an existing session. Requires join token. |
| `GET /retrieve/:code?k=<token>` | Retrieve session data. Requires join token. |
| `GET /file/:fileId/:token` | Download a file by token. |
| `POST /session` | Create a live P2P session (password mandatory). |
| `WS /` | WebSocket signaling for live sessions. |
| `GET /ai/status/:code?k=<token>` | AI indexing status. Requires join token. |
| `POST /ai/query/:code?k=<token>` | Ask a question about the session. Requires join token. |
| `GET /ice-servers` | Cached STUN/TURN server list. |
| `GET /health` | Health check. |
| `GET /stats` | Server statistics (requires `STATS_KEY`). |
| `GET /metrics` | Prometheus metrics (request duration, WebSocket connections, AI queries, memory). |
| `POST /csp-report` | CSP violation reporting endpoint. |
| `GET /robots.txt` | Disallows all crawling. |
| `GET /.well-known/security.txt` | Security contact and policy. |

---

## Testing

```bash
cd signaling-server && npm test
```

95 tests covering RAG pipeline logic, embedding provider orchestration, circuit breakers, memory profiling, input sanitization, filename sanitization, security logging, session management, and answer caching.

---

## Scripts

### Backend (`signaling-server`)

| Command | Description |
|---|---|
| `npm run dev` | Hot-reload dev server |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm start` | Production runner |
| `npm test` | Unit tests |

### Frontend (`client`)

| Command | Description |
|---|---|
| `npm run dev` | Dev server on :4000 |
| `npm run build` | Type-check + production bundle |
| `npm run lint` | ESLint |

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `AI answering needs the operator to configure GROQ_API_KEY` | Set `GROQ_API_KEY` in your hosting dashboard (`.env` is gitignored and doesn't deploy). |
| `AI is rate-limited` | Free-tier quota or per-IP limiter — wait and retry. |
| `This session has expired` | TTL passed (default 1h, max 10h) — publish again. |
| `Indexing failed` | Check logs. Provider issues degrade to keyword mode instead of failing. Add an API key to upgrade. |
| Partial answers for large books | Enumeration questions trigger wide recall (80 blocks + heading scan). Scanned PDF pages may be skipped — check OCR logs. |
| CORS errors | Client origin must be in `ALLOWED_ORIGINS` (dev: client 4000, server 3002). |
| 401 on retrieve | Stored sessions require `?k=<token>` — the 6-digit code alone no longer authorizes access. |
| 429 on AI query | Per-session or per-IP AI limit hit — wait and retry. |
| 503 on upload | Upload bandwidth cap or memory pressure — check server logs. |

---

## License

Open-source project. Open sessions are stored unencrypted on the server and indexed for AI — do not put secrets in them. Use Private mode for anything sensitive: content is encrypted in your browser, unreadable to the server, and excluded from all AI processing.
