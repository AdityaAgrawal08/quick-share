// ── Toast event bus ──────────────────────────────────────────────────────────
// Non-component module so react-refresh only sees components in Toast.tsx.

export type ToastKind = 'info' | 'error' | 'success'

export interface ToastItem {
  id: number
  message: string
  kind: ToastKind
}

type Listener = (t: ToastItem) => void

let listener: Listener | null = null
let nextId = 1

export function subscribeToasts(fn: Listener): () => void {
  listener = fn
  return () => { listener = null }
}

export function toast(message: string, kind: ToastKind = 'info'): void {
  listener?.({ id: nextId++, message, kind })
}
