import { useEffect, useState } from 'react'
import { subscribeToasts, type ToastItem } from './toastBus'

export function ToastHost() {
  const [items, setItems] = useState<ToastItem[]>([])
  useEffect(() => {
    return subscribeToasts(t => {
      setItems(prev => [...prev, t])
      setTimeout(() => setItems(prev => prev.filter(x => x.id !== t.id)), 3400)
    })
  }, [])
  if (items.length === 0) return null
  return (
    <div aria-live="polite" role="status" style={{
      position: 'fixed', bottom: 18, left: '50%', transform: 'translateX(-50%)',
      zIndex: 9999, display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'center',
      maxWidth: 'min(360px, calc(100vw - 24px))', pointerEvents: 'none'
    }}>
      {items.map(t => (
        <div key={t.id} style={{
          padding: '10px 14px', borderRadius: 'var(--radius-pill)',
          border: `1px solid ${t.kind === 'error' ? 'var(--error)' : t.kind === 'success' ? 'var(--success)' : 'var(--border-strong)'}`,
          background: t.kind === 'error' ? 'var(--error)' : t.kind === 'success' ? 'var(--success)' : 'var(--surface)',
          color: t.kind === 'error' || t.kind === 'success' ? '#fff' : 'var(--text)',
          boxShadow: '0 10px 28px rgba(0,0,0,0.22)', fontSize: '0.84rem', fontWeight: 650,
          animation: 'toast-in 180ms ease-out', pointerEvents: 'auto', textAlign: 'center'
        }}>
          {t.message}
        </div>
      ))}
    </div>
  )
}
