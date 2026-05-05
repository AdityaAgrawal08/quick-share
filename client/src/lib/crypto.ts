/**
 * Client-side End-to-End Encryption (E2EE) using AES-GCM.
 * This allows QuickShare to store files in the cloud without the server ever knowing the contents.
 */

const ITERATIONS = 100000;
const KEY_LEN = 256;
const SALT_LEN = 16;
const IV_LEN = 12;

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const totalLength = parts.reduce((sum, part) => sum + part.length, 0)
  const combined = new Uint8Array(totalLength)
  let offset = 0

  for (const part of parts) {
    combined.set(part, offset)
    offset += part.length
  }

  return combined
}

export function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  let binary = ''

  for (let index = 0; index < bytes.length; index++) {
    binary += String.fromCharCode(bytes[index])
  }

  return btoa(binary)
}

export function base64ToArrayBuffer(encoded: string): ArrayBuffer {
  const binary = atob(encoded)
  const bytes = new Uint8Array(binary.length)

  for (let index = 0; index < binary.length; index++) {
    bytes[index] = binary.charCodeAt(index)
  }

  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

/**
 * Derives an AES-GCM key from a password and salt.
 */
async function deriveKey(password: string, salt: BufferSource): Promise<CryptoKey> {
  const enc = new TextEncoder();
  const keyMaterial = await window.crypto.subtle.importKey(
    'raw',
    enc.encode(password),
    'PBKDF2',
    false,
    ['deriveBits', 'deriveKey']
  );
  return window.crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt,
      iterations: ITERATIONS,
      hash: 'SHA-256',
    },
    keyMaterial,
    { name: 'AES-GCM', length: KEY_LEN },
    false,
    ['encrypt', 'decrypt']
  );
}

/**
 * Encrypts a string or ArrayBuffer.
 * Returns a concatenated ArrayBuffer: [salt (16B)] [iv (12B)] [ciphertext]
 */
export async function encrypt(data: string | ArrayBuffer, password: string): Promise<ArrayBuffer> {
  const enc = new TextEncoder();
  const encodedData = typeof data === 'string' ? enc.encode(data) : data;

  const salt = window.crypto.getRandomValues(new Uint8Array(SALT_LEN));
  const iv = window.crypto.getRandomValues(new Uint8Array(IV_LEN));
  const key = await deriveKey(password, salt);

  const ciphertext = await window.crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    encodedData
  );

  // Combine salt + iv + ciphertext
  const combined = concatBytes(salt, iv, new Uint8Array(ciphertext))
  return combined.buffer.slice(combined.byteOffset, combined.byteOffset + combined.byteLength) as ArrayBuffer
}

/**
 * Decrypts a combined ArrayBuffer back into its original form.
 */
export async function decrypt(combined: ArrayBuffer, password: string, isText: boolean = false): Promise<string | ArrayBuffer> {
  const salt = combined.slice(0, SALT_LEN);
  const iv = combined.slice(SALT_LEN, SALT_LEN + IV_LEN);
  const ciphertext = combined.slice(SALT_LEN + IV_LEN);

  const key = await deriveKey(password, salt);

  try {
    const decrypted = await window.crypto.subtle.decrypt(
      { name: 'AES-GCM', iv },
      key,
      ciphertext
    );

    if (isText) {
      return new TextDecoder().decode(decrypted);
    }
    return decrypted;
  } catch (err) {
    throw new Error('Decryption failed. Check your password.');
  }
}
