// Security utility functions — extracted for testability.
// Item 5: sanitiseTextContent, Item 6: sanitiseFilename

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

// Security: sanitise user-supplied text content (Item 5)
// Removes script tags, event handlers, javascript: URIs, and data: URIs
// that could execute code when the text is rendered in the UI.
export function sanitiseTextContent(text: string): string {
  return text
    // Script tags (including multiline)
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gim, '')
    .replace(/<script\b[^>]*\/?>/gim, '')
    // Event handlers on any element
    .replace(/\bon\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    // javascript: URIs
    .replace(/javascript\s*:/gi, '')
    // data: URIs (except images in img src)
    .replace(/data\s*:(?!image\/)/gi, '')
    // VBScript (legacy IE)
    .replace(/vbscript\s*:/gi, '')
    // <base> tag hijacking
    .replace(/<base\b[^>]*>/gim, '')
    // <meta> refresh redirect
    .replace(/<meta\b[^>]*http-equiv\s*=\s*["']?refresh["']?[^>]*>/gim, '')
    // <iframe> and <object> and <embed>
    .replace(/<(iframe|object|embed|applet)\b[^>]*>[\s\S]*?<\/\1>/gim, '')
    .replace(/<(iframe|object|embed|applet)\b[^>]*\/?>/gim, '')
    .trim()
}
