/**
 * MIME resolution helpers.
 *
 * Browsers will only render a blob:// URL in a new tab when the Blob has a
 * renderable Content-Type; generic types (application/octet-stream / "") are
 * downloaded instead of displayed. Several flows in this app lose the real
 * type (encrypted uploads historically stored everything as octet-stream,
 * files picked from Linux machines often have File.type === ""), so on the
 * receiving side we recover it from the filename extension.
 */

const EXT_TO_MIME: Record<string, string> = {
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  avif: 'image/avif',
  txt: 'text/plain',
  md: 'text/markdown',
  csv: 'text/csv',
  json: 'application/json',
  xml: 'application/xml',
  html: 'text/html',
  htm: 'text/html',
  js: 'text/javascript',
  ts: 'text/plain',
  css: 'text/css',
  log: 'text/plain',
  yaml: 'text/yaml',
  yml: 'text/yaml',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  mkv: 'video/x-matroska',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  flac: 'audio/flac',
  m4a: 'audio/mp4',
  zip: 'application/zip',
  gz: 'application/gzip',
  tar: 'application/x-tar',
  rar: 'application/vnd.rar',
  '7z': 'application/x-7z-compressed',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  wasm: 'application/wasm',
}

const GENERIC_TYPES = new Set(['', 'application/octet-stream', 'binary/octet-stream'])

/**
 * Prefer a meaningful declared type; otherwise infer from the file extension.
 */
export function guessMime(name: string, declared?: string): string {
  const d = (declared ?? '').trim().toLowerCase()
  if (!GENERIC_TYPES.has(d)) return d
  const dot = name.lastIndexOf('.')
  if (dot === -1) return 'application/octet-stream'
  const ext = name.slice(dot + 1).toLowerCase()
  return EXT_TO_MIME[ext] ?? 'application/octet-stream'
}
