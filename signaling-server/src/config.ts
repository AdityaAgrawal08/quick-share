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
  RERANK_MODEL:     process.env.RAG_RERANK_MODEL || 'Xenova/bge-reranker-base',
  CHUNK_SIZE_CHARS: parseInt(process.env.RAG_CHUNK_SIZE ?? '600', 10),
  CHUNK_OVERLAP_CHARS: parseInt(process.env.RAG_CHUNK_OVERLAP ?? '90', 10),
  MAX_CHUNKS_PER_SESSION: parseInt(process.env.RAG_MAX_CHUNKS ?? '4000', 10),
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
