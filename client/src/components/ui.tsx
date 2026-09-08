import type { ReactNode, CSSProperties, ButtonHTMLAttributes, InputHTMLAttributes, TextareaHTMLAttributes } from 'react'

export function Card({ children, className = '', style, pad = true, onClick }: { children: ReactNode; className?: string; style?: CSSProperties; pad?: boolean; onClick?: () => void }) {
  return <div className={`card ${pad ? 'card--pad' : ''} ${className}`} style={style} onClick={onClick}>{children}</div>
}

type BtnProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'ghost' | 'icon'
  size?: 'sm' | 'md' | 'lg'
  block?: boolean
}
export function Btn({ children, variant = 'secondary', size = 'md', block, className = '', style, ...rest }: BtnProps) {
  const v = variant === 'primary' ? 'btn--primary' : variant === 'ghost' ? 'btn--ghost' : variant === 'icon' ? 'btn--icon' : 'btn--secondary'
  const s = size === 'sm' ? 'btn--sm' : size === 'lg' ? 'btn--lg' : ''
  const b = block ? 'btn--block' : ''
  return <button className={`btn ${v} ${s} ${b} ${className}`} style={style} {...rest}>{children}</button>
}

export function Badge({ children, tone = 'default', dot }: { children: ReactNode; tone?: 'default' | 'accent' | 'success' | 'live'; dot?: boolean }) {
  const t = tone === 'accent' ? 'badge--accent' : tone === 'success' ? 'badge--success' : tone === 'live' ? 'badge--live' : ''
  return <span className={`badge ${t}`}>{dot && <span className="badge__dot" />} {children}</span>
}

export function Field({ label, hint, error, children, htmlFor }: { label?: string; hint?: string; error?: string; children: ReactNode; htmlFor?: string }) {
  return (
    <div className="field">
      {label && <label htmlFor={htmlFor} className="field__label">{label}</label>}
      {children}
      {error ? <span className="field__error">{error}</span> : hint ? <span className="field__hint">{hint}</span> : null}
    </div>
  )
}

export function TextInput(props: InputHTMLAttributes<HTMLInputElement> & { error?: boolean; mono?: boolean; icon?: ReactNode }) {
  const { error, mono, icon, className = '', style, ...rest } = props
  if (icon) {
    return (
      <div className="input-wrap">
        <span className="input-wrap__icon">{icon}</span>
        <input className={`input input--with-icon ${mono ? 'input--mono' : ''} ${error ? 'input--error' : ''} ${className}`} style={style} {...rest} />
      </div>
    )
  }
  return <input className={`input ${mono ? 'input--mono' : ''} ${error ? 'input--error' : ''} ${className}`} style={style} {...rest} />
}

export function TextArea(props: TextareaHTMLAttributes<HTMLTextAreaElement> & { error?: boolean }) {
  const { error, className = '', ...rest } = props
  return <textarea className={`input textarea ${error ? 'input--error' : ''} ${className}`} {...rest} />
}

export function Progress({ percent, thin }: { percent: number; thin?: boolean }) {
  return <div className={`progress ${thin ? 'progress--thin' : ''}`}><div className="progress__fill" style={{ width: `${Math.max(0, Math.min(100, percent))}%` }} /></div>
}

export function Spinner({ size = 16, style }: { size?: number; style?: CSSProperties }) {
  return (
    <svg width={size} height={size} style={{ animation: 'spin 0.85s linear infinite', ...style }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 2v3M12 19v3M4.93 4.93l2.12 2.12M17.66 17.66l2.12 2.12M2 12h3M19 12h3M4.93 19.07l2.12-2.12M17.66 6.34l2.12-2.12" />
    </svg>
  )
}

export function Icon({ name, size = 18, style }: { name: 'rocket' | 'lock' | 'cloud' | 'shield' | 'zap' | 'file' | 'copy' | 'check' | 'sun' | 'moon' | 'link' | 'upload' | 'clock' | 'users' | 'sparkles' | 'trash' | 'eye' | 'download' | 'alert', size?: number, style?: CSSProperties }) {
  const paths: Record<string, ReactNode> = {
    rocket: <path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.71-2.13.09-2.91a2.18 2.18 0 0 0-3.09-.09zM14.5 6.5L10 11l-1.42-1.42 3.71-3.71A5 5 0 0 1 18 5c0 2.21-1.79 4-4 4a5 5 0 0 1-4.26-2.25zM15.26 17.25l1.42 1.42-3.71 3.71A5 5 0 0 1 6 19c0-2.21 1.79-4 4-4a5 5 0 0 1 4.26 2.25z" />,
    lock: <><rect x="3" y="11" width="18" height="11" rx="2" ry="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" /></>,
    cloud: <><path d="M17.5 19H9a4 4 0 0 1 0-8 5.5 5.5 0 0 1 10.8-1.2A3.5 3.5 0 0 1 17.5 19z" /><path d="M12 13l-2 2 2 2M12 15h0M9 19h6" /></>,
    shield: <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />,
    zap: <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />,
    file: <><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" /><polyline points="13 2 13 9 20 9" /></>,
    copy: <><rect x="9" y="9" width="13" height="13" rx="2" ry="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></>,
    check: <polyline points="20 6 9 17 4 12" />,
    sun: <><circle cx="12" cy="12" r="4" /><path d="M12 2v1M12 21v1M4.22 4.22l.7.7M18.36 18.36l.7.7M2 12h1M21 12h1M4.22 19.78l.7-.7M18.36 5.64l.7-.7" /></>,
    moon: <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />,
    link: <><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" /><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" /></>,
    upload: <><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="17 8 12 3 7 8" /><line x1="12" y1="3" x2="12" y2="15" /></>,
    clock: <><circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" /></>,
    users: <><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M22 21v-2a4 4 0 0 0-3-3.87" /><path d="M16 3.13a4 4 0 0 1 0 7.75" /></>,
    sparkles: <><path d="M12 3l1.2 3.8L17 8l-3.8 1.2L12 13l-1.2-3.8L7 8l3.8-1.2z" /><path d="M19 13l.8 2.2L22 16l-2.2.8L19 19l-.8-2.2L16 16l2.2-.8z" /><path d="M5 14l.8 1.8L8 16l-2.2.8L5 19l-.8-2.2L2 16l2.2-.8z" /></>,
    trash: <><polyline points="3 6 5 6 21 6" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /></>,
    eye: <><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" /><circle cx="12" cy="12" r="3" /></>,
    download: <><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" /></>,
    alert: <><circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" /></>,
  }
  return <svg width={size} height={size} style={style} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round" aria-hidden>{paths[name]}</svg>
}
