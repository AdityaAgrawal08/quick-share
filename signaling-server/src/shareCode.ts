import { randomBytes } from 'crypto'

// Session codes are bearer credentials for open stored sessions. The alphabet
// avoids visually ambiguous characters while retaining 80 bits of entropy.
const SHARE_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
export const SHARE_CODE_LENGTH = 16
export const SHARE_CODE_PATTERN = /^[A-HJ-NP-Z2-9]{16}$/

export function generateShareCode(): string {
  const bytes = randomBytes(SHARE_CODE_LENGTH)
  let code = ''
  for (const byte of bytes) {
    // The alphabet contains 32 characters, so this maps random bits without
    // modulo bias and yields exactly 80 bits of entropy.
    code += SHARE_CODE_ALPHABET[byte & 0x1f]
  }
  return code
}

export function normaliseShareCode(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const code = value.trim().toUpperCase()
  return SHARE_CODE_PATTERN.test(code) ? code : null
}
