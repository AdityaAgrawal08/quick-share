import pino from 'pino'

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  // Session codes, file tokens, and passwords are bearer credentials. Redact
  // them at the logger boundary so a future structured log cannot leak them.
  redact: {
    paths: [
      'code', '*.code',
      'token', '*.token',
      'password', '*.password',
      'passwordHash', '*.passwordHash',
      'authorization', '*.authorization',
    ],
    censor: '[REDACTED]',
  },
  transport: process.env.NODE_ENV !== 'production' ? {
    target: 'pino-pretty',
    options: {
      colorize: true,
      translateTime: 'HH:MM:ss Z',
      ignore: 'pid,hostname',
    }
  } : undefined
})

export default logger
