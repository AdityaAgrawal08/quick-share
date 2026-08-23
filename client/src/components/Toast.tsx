import { useEffect, useState } from 'react'
import { subscribeToasts, type ToastItem } from './toastBus'

// ── Toast host ───────────────────────────────────────────────────────────────
// Mount once in the app root. Emit toasts from anywhere via toast() from
// ./toastBus. Auto-dismisses after 3.5s.

export function ToastHost() {
  const [items, setItems] = useState<ToastItem[]>([])

  useEffect(() => {
    return subscribeToasts(t => {
      setItems(prev => [...prev, t])
      setTimeout(() => {
        setItems(prev => prev.filter(x => x.id !== t.id))
      }, 3500)
    })
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
