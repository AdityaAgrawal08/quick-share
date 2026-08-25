import path from 'path'
import fs from 'fs'
import logger from './logger'

// Load .env manually if not handled by external runner
const envPath = path.resolve(__dirname, '../.env')
if (fs.existsSync(envPath)) {
  fs.readFileSync(envPath, 'utf8')
    .split('\n')
    .forEach((rawLine) => {
      const line = rawLine.trim().replace(/\r$/, '')
      if (!line || line.startsWith('#')) return
      const eq = line.indexOf('=')
      if (eq <= 0) return
      const key = line.slice(0, eq).trim()
      let value = line.slice(eq + 1).trim()
      // Strip surrounding quotes so PASSWORD="secret" doesn't keep the quotes.
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1)
      }
      if (key && !(key in process.env)) process.env[key] = value
    })
}

export const CONFIG = {
  PORT:             parseInt(process.env.PORT ?? '3001', 10),
  MONGODB_URI:      process.env.MONGODB_URI, // Optional, enables stored mode
  MONGODB_TLS_INSECURE: process.env.MONGODB_TLS_INSECURE === 'true' || process.env.MONGODB_TLS_INSECURE === '1',
  ALLOWED_ORIGINS: process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim())
  : [],
  SESSION_TTL_MS:   parseInt(process.env.SESSION_TTL_MS ?? '86400000', 10),
  STORED_MAX_BYTES: 10 * 1024 * 1024,
  MAX_FILE_SIZE:    100 * 1024 * 1024,
  NODE_ENV:         process.env.NODE_ENV || 'development',
  // ── RAG agent ──────────────────────────────────────────────────────────
  GROQ_API_KEY:     process.env.GROQ_API_KEY,
  GROQ_MODEL:       process.env.GROQ_MODEL || 'openai/gpt-oss-120b',
  RAG_ENABLED:      process.env.RAG_ENABLED !== 'false',
  EMBED_MODEL:      process.env.RAG_EMBED_MODEL || 'Xenova/bge-small-en-v1.5',
  // ONNX quantization for the local embedder — q8 keeps RAM ~4x lower than fp32.
  EMBED_DTYPE:      process.env.RAG_EMBED_DTYPE || 'q8',
  RERANK_MODEL:     process.env.RAG_RERANK_MODEL || 'Xenova/bge-reranker-base',
  // Cross-encoder reranking adds ~400MB resident RAM — off by default so the
  // app fits small free-tier hosts (Render 512MB). Fusion ranking alone
  // scored hit@3=1.0 on the eval set. Opt in only on ≥1GB instances.
  RAG_RERANK_ENABLED: process.env.RAG_RERANK_ENABLED === 'true',
  CHUNK_SIZE_CHARS: parseInt(process.env.RAG_CHUNK_SIZE ?? '600', 10),
  CHUNK_OVERLAP_CHARS: parseInt(process.env.RAG_CHUNK_OVERLAP ?? '90', 10),
  MAX_CHUNKS_PER_SESSION: parseInt(process.env.RAG_MAX_CHUNKS ?? '4000', 10),
  // ── External embedding providers (optional; local BGE remains fallback) ───
  // Registry order defaults to [cohere → voyage → local]; override sequence:
  RAG_PROVIDER_ORDER: (process.env.RAG_PROVIDER_ORDER ?? 'cohere,voyage,local')
    .split(',').map(s => s.trim()).filter(Boolean),
  COHERE_API_KEY: process.env.COHERE_API_KEY,
  COHERE_EMBED_MODEL: process.env.COHERE_EMBED_MODEL || 'embed-v4.0',
  COHERE_EMBED_DIM: parseInt(process.env.COHERE_EMBED_DIM ?? '1536', 10),
  VOYAGE_API_KEY: process.env.VOYAGE_API_KEY,
  VOYAGE_EMBED_MODEL: process.env.VOYAGE_EMBED_MODEL || 'voyage-4-lite',
  VOYAGE_EMBED_DIM: parseInt(process.env.VOYAGE_EMBED_DIM ?? '1024', 10),
  // Per-request timeout and min spacing between requests to one provider
  // (basic pacing — review §9 check-then-act races).
  PROVIDER_TIMEOUT_MS: parseInt(process.env.RAG_PROVIDER_TIMEOUT_MS ?? '20000', 10),
  PROVIDER_MIN_INTERVAL_MS: parseInt(process.env.RAG_PROVIDER_MIN_INTERVAL_MS ?? '250', 10),
  // ── Adaptive memory tiers (see rag/memory-profile.ts) ─────────────────────
  // Local ONNX embedder on TINY hosts (<768MB): OFF by default — native
  // inference allocations cannot be guaranteed under a 480MB target.
  RAG_ALLOW_LOCAL_TINY: process.env.RAG_ALLOW_LOCAL_TINY === 'true',
  // Disable the local embedder entirely (APIs only), any tier.
  RAG_DISABLE_LOCAL: process.env.RAG_DISABLE_LOCAL === 'true',
  // Direct-stuffing budget is TOKEN-based, tied to the active Groq model's
  // context window (review §4) — never a bare character constant.
  LLM_CONTEXT_TOKENS: parseInt(process.env.LLM_CONTEXT_TOKENS ?? '131072', 10),
  // Portion of the window usable for stuffed content (~25%; rest = prompt +
  // answer headroom). Conservative 3 chars/token converts to the char gate
  // below, so we UNDER-stuff if the estimator is wrong — the safe direction.
  DIRECT_STUFF_MAX_TOKENS: parseInt(
    process.env.RAG_DIRECT_STUFF_MAX_TOKENS ?? String(Math.floor(131072 * 0.25)),
    10,
  ),
  DIRECT_STUFF_MAX_CHARS: parseInt(
    process.env.RAG_DIRECT_STUFF_CHARS ??
      String(parseInt(process.env.RAG_DIRECT_STUFF_MAX_TOKENS ?? '32768', 10) * 3),
    10,
  ),
  // Emergency kill switch: force EVERY corpus through direct stuffing so the
  // local embedder can never load. Use on hosts without measured headroom.
  RAG_FORCE_DIRECT: process.env.RAG_FORCE_DIRECT === 'true',
  // Pause (not OOM-kill) vector jobs once process RSS crosses this budget.
  // Durable work units make the eventual retry cheap.
  EMBED_MAX_RSS_MB: parseInt(process.env.RAG_EMBED_MAX_RSS_MB ?? '384', 10),
  // Resume-without-re-extraction of durable chunk work units after a
  // provider failure or process death.
  RAG_RESUME_ENABLED: process.env.RAG_RESUME_ENABLED !== 'false',
  // Embedding provider circuit breaker.
  BREAKER_THRESHOLD: parseInt(process.env.RAG_BREAKER_THRESHOLD ?? '3', 10),
  BREAKER_COOLDOWN_MS: parseInt(process.env.RAG_BREAKER_COOLDOWN_MS ?? '30000', 10),
  // LRU cap on in-memory retrieval indexes (each holds chunks + Float32 vectors).
  RAG_INDEX_CACHE_MAX: parseInt(process.env.RAG_INDEX_CACHE_MAX ?? '12', 10),
}

// Validation
if (CONFIG.NODE_ENV === 'production') {
  if (CONFIG.ALLOWED_ORIGINS.includes('*')) {
    logger.warn('Security Warning: ALLOWED_ORIGINS is set to "*" in production.')
  }
  if (!CONFIG.MONGODB_URI) {
    logger.warn('Running in production without MONGODB_URI (Stored Mode disabled).')
  }
}

logger.info({ 
  msg: 'Configuration loaded',
  port: CONFIG.PORT,
  origins: CONFIG.ALLOWED_ORIGINS,
  storedMode: !!CONFIG.MONGODB_URI,
  mongoTlsInsecure: CONFIG.MONGODB_TLS_INSECURE
})
