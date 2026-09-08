import pino from 'pino'

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: process.env.NODE_ENV !== 'production' ? {
    target: 'pino-pretty',
    options: {
      colorize: true,
      translateTime: 'HH:MM:ss Z',
      ignore: 'pid,hostname',
    }
  } : undefined
})

// Security: Structured security event logger (CWE-778)
// Logs security-relevant events for intrusion detection and forensics.
// NEVER logs: passwords, encryption keys, session tokens, file contents.
export const securityLog = {
  unauthorized_access: (ctx: { code: string; ip: string; reason: string }) =>
    logger.warn({ event: 'security.unauthorized', ...ctx }, 'Unauthorized access attempt'),
  token_invalid: (ctx: { code: string; ip: string }) =>
    logger.warn({ event: 'security.token_invalid', ...ctx }, 'Invalid join token'),
  rate_limited: (ctx: { ip: string; endpoint: string }) =>
    logger.warn({ event: 'security.rate_limited', ...ctx }, 'Rate limit exceeded'),
  session_expired: (ctx: { code: string }) =>
    logger.info({ event: 'security.session_expired', ...ctx }, 'Session expired'),
  session_deleted: (ctx: { code: string; reason: string }) =>
    logger.info({ event: 'security.session_deleted', ...ctx }, 'Session deleted'),
  upload_rejected: (ctx: { ip: string; reason: string }) =>
    logger.warn({ event: 'security.upload_rejected', ...ctx }, 'Upload rejected'),
  ai_quota_exceeded: (ctx: { code: string; ip: string }) =>
    logger.warn({ event: 'security.ai_quota', ...ctx }, 'AI quota exceeded'),
  burn_triggered: (ctx: { code: string }) =>
    logger.info({ event: 'security.burn', ...ctx }, 'Burn-on-read triggered'),
}

export default logger
