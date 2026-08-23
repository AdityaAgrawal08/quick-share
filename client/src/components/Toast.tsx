import { useEffect, useState } from 'react'

// ── Minimal toast system ─────────────────────────────────────────────────────
// Zero-dependency: a module-level listener + <ToastHost/> mounted once in App.
// toast('message', 'error') from anywhere; auto-dismisses after 3.5s.

export type ToastKind = 'info' | 'error' | 'success'

interface ToastItem {
  id: number
  message: string
  kind: ToastKind
}

type Listener = (t: ToastItem) => void
let listener: Listener | null = null
let nextId = 1

export function toast(message: string, kind: ToastKind = 'info'): void {
  const item = { id: nextId++, message, kind }
  listener?.(item)
}

export function ToastHost() {
  const [items, setItems] = useState<ToastItem[]>([])

  useEffect(() => {
    listener = (t) => {
      setItems(prev => [...prev, t])
      setTimeout(() => {
        setItems(prev => prev.filter(x => x.id !== t.id))
      }, 3500)
    }
    return () => { listener = null }
  }, [])

  if (items.length === 0) return null

  return (
    <div aria-live="polite" role="status" style={{
      position: 'fixed', bottom: 20, right: 20, zIndex: 9999,
      display: 'flex', flexDirection: 'column', gap: 8, maxWidth: 'min(340px, calc(100vw - 40px))',
    }}>
      {items.map(t => (
        <div key={t.id} style={{
          padding: '10px 14px',
          borderRadius: 'var(--radius)',
          border: `1px solid ${t.kind === 'error' ? 'var(--error)' : 'var(--border)'}`,
          background: 'var(--surface)',
          color: t.kind === 'error' ? 'var(--error)' : (t.kind === 'success' ? 'var(--success)' : 'var(--text)'),
          boxShadow: '0 6px 24px rgba(0,0,0,.25)',
          fontSize: '0.8125rem', fontWeight: 500,
          animation: 'toast-in .18s ease-out',
        }}>
          {t.message}
        </div>
      ))}
    </div>
  )
}
