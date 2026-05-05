import path from 'path'
import fs from 'fs'
import logger from './logger'

// Load .env manually if not handled by external runner
const envPath = path.resolve(__dirname, '../.env')
if (fs.existsSync(envPath)) {
  fs.readFileSync(envPath, 'utf8')
    .split('\n')
    .forEach((line) => {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) return
      const [key, ...rest] = trimmed.split('=')
      if (key && !(key in process.env)) process.env[key] = rest.join('=')
    })
}

function required(key: string): string {
  const val = process.env[key]
  if (!val) {
    logger.error(`FATAL: Missing required environment variable: ${key}`)
    process.exit(1)
  }
  return val
}

export const CONFIG = {
  PORT:             parseInt(process.env.PORT ?? '3001', 10),
  MONGODB_URI:      process.env.MONGODB_URI, // Optional, enables stored mode
  MONGODB_TLS_INSECURE: process.env.MONGODB_TLS_INSECURE === 'true' || process.env.MONGODB_TLS_INSECURE === '1',
  ALLOWED_ORIGINS:  (process.env.ALLOWED_ORIGINS ?? '*')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  SESSION_TTL_MS:   parseInt(process.env.SESSION_TTL_MS ?? '86400000', 10),
  STORED_MAX_BYTES: 10 * 1024 * 1024,
  MAX_FILE_SIZE:    100 * 1024 * 1024,
  NODE_ENV:         process.env.NODE_ENV || 'development',
  ICE_SERVERS:      process.env.ICE_SERVERS ? JSON.parse(process.env.ICE_SERVERS) : [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ],
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
