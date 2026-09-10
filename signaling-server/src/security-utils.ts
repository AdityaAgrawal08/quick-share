// Security utility functions — extracted for testability.

// Takes basename only (strips path), removes null bytes, double-dots, and
// control characters. Enforces max length.
export function sanitiseFilename(name: string): string {
  const base = name.replace(/\\/g, '/').split('/').pop() ?? ''
  const sanitised = base
    .replace(/\x00/g, '')          // null bytes
    .replace(/\.\./g, '')          // path traversal
    .replace(/[\x00-\x1f\x7f]/g, '') // control characters
    .replace(/[<>:"|?*]/g, '')     // Windows-unsafe chars
    .trim()
    .slice(0, 255)
  return sanitised || 'file'
}

// Sanitise user-supplied text content.
// Removes script tags, event handlers, javascript: URIs, and data: URIs
// that could execute code when the text is rendered in the UI.
export function sanitiseTextContent(text: string): string {
  return text
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gim, '')
    .replace(/<script\b[^>]*\/?>/gim, '')
    .replace(/\bon\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/javascript\s*:/gi, '')
    .replace(/data\s*:(?!image\/)/gi, '')
    .replace(/vbscript\s*:/gi, '')
    .replace(/<base\b[^>]*>/gim, '')
    .replace(/<meta\b[^>]*http-equiv\s*=\s*["']?refresh["']?[^>]*>/gim, '')
    .replace(/<(iframe|object|embed|applet)\b[^>]*>[\s\S]*?<\/\1>/gim, '')
    .replace(/<(iframe|object|embed|applet)\b[^>]*\/?>/gim, '')
    .trim()
}
