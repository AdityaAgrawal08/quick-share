import React, { type ReactNode } from 'react'

interface MarkdownViewProps {
  content: string
}

function renderInline(text: string, keyPrefix = 'inline'): ReactNode[] {
  if (!text) return []

  // Match inline tokens:
  // 1. Code: `code` or <code>code</code>
  // 2. Bold italic: ***text***
  // 3. Bold: **text**, __text__, <b>text</b>, <strong>text</strong>
  // 4. Italic: *text*, _text_, <i>text</i>, <em>text</em>
  // 5. Citations: [[1]], 【1】
  // 6. Links: [label](url)
  // 7. Line breaks: <br>, <br/>, <br />, or \n
  const tokenRegex = /(`[^`]+`|<code>[\s\S]*?<\/code>|\*\*\*[^*]+?\*\*\*|\*\*[^*]+?\*\*|__[^_]+?__|<b>[\s\S]*?<\/b>|<strong>[\s\S]*?<\/strong>|(?<!\*)\*[^*]+?\*(?!\*)|(?<!_)_[^_]+?_(?!_)|<i>[\s\S]*?<\/i>|<em>[\s\S]*?<\/em>|\[\[\d+\]\]|【\d+】|\[[^\]]+\]\(https?:\/\/[^\s)]+\)|<br\s*\/?>|\n)/gi

  const result: ReactNode[] = []
  let lastIndex = 0
  let match: RegExpExecArray | null

  while ((match = tokenRegex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      result.push(text.slice(lastIndex, match.index))
    }

    const token = match[0]
    const key = `${keyPrefix}-${match.index}`

    if (token === '\n' || /^<br\s*\/?>$/i.test(token)) {
      result.push(<br key={key} />)
    } else if (token.startsWith('`') && token.endsWith('`')) {
      result.push(
        <code
          key={key}
          style={{
            background: 'var(--surface-3)',
            padding: '1px 5px',
            borderRadius: 4,
            fontFamily: 'var(--font-mono)',
            fontSize: '0.84em',
          }}
        >
          {token.slice(1, -1)}
        </code>
      )
    } else if (/^<code>[\s\S]*?<\/code>$/i.test(token)) {
      result.push(
        <code
          key={key}
          style={{
            background: 'var(--surface-3)',
            padding: '1px 5px',
            borderRadius: 4,
            fontFamily: 'var(--font-mono)',
            fontSize: '0.84em',
          }}
        >
          {token.replace(/^<code>/i, '').replace(/<\/code>$/i, '')}
        </code>
      )
    } else if (token.startsWith('***') && token.endsWith('***')) {
      result.push(
        <strong key={key} style={{ fontWeight: 700 }}>
          <em style={{ fontStyle: 'italic' }}>
            {renderInline(token.slice(3, -3), `${key}-bi`)}
          </em>
        </strong>
      )
    } else if (
      (token.startsWith('**') && token.endsWith('**')) ||
      (token.startsWith('__') && token.endsWith('__'))
    ) {
      result.push(
        <strong key={key} style={{ fontWeight: 700 }}>
          {renderInline(token.slice(2, -2), `${key}-b`)}
        </strong>
      )
    } else if (/^<(?:b|strong)>[\s\S]*?<\/(?:b|strong)>$/i.test(token)) {
      const inner = token.replace(/^<(?:b|strong)>/i, '').replace(/<\/(?:b|strong)>$/i, '')
      result.push(
        <strong key={key} style={{ fontWeight: 700 }}>
          {renderInline(inner, `${key}-b`)}
        </strong>
      )
    } else if (
      (token.startsWith('*') && token.endsWith('*')) ||
      (token.startsWith('_') && token.endsWith('_'))
    ) {
      result.push(
        <em key={key} style={{ fontStyle: 'italic' }}>
          {renderInline(token.slice(1, -1), `${key}-i`)}
        </em>
      )
    } else if (/^<(?:i|em)>[\s\S]*?<\/(?:i|em)>$/i.test(token)) {
      const inner = token.replace(/^<(?:i|em)>/i, '').replace(/<\/(?:i|em)>$/i, '')
      result.push(
        <em key={key} style={{ fontStyle: 'italic' }}>
          {renderInline(inner, `${key}-i`)}
        </em>
      )
    } else if (
      (token.startsWith('[[') && token.endsWith(']]')) ||
      (token.startsWith('【') && token.endsWith('】'))
    ) {
      const num = token.slice(token.startsWith('[[') ? 2 : 1, token.endsWith(']]') ? -2 : -1)
      result.push(
        <span
          key={key}
          style={{
            fontSize: '0.74em',
            padding: '1px 5px',
            borderRadius: 4,
            background: 'var(--accent-soft)',
            color: 'var(--accent)',
            fontWeight: 700,
            margin: '0 2px',
            display: 'inline-block',
            verticalAlign: 'baseline',
          }}
        >
          [{num}]
        </span>
      )
    } else {
      const linkMatch = token.match(/^\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)$/)
      if (linkMatch) {
        result.push(
          <a
            key={key}
            href={linkMatch[2]}
            target="_blank"
            rel="noopener noreferrer"
            style={{ color: 'var(--accent)', textDecoration: 'underline' }}
          >
            {linkMatch[1]}
          </a>
        )
      } else {
        result.push(token)
      }
    }

    lastIndex = match.index + token.length
  }

  if (lastIndex < text.length) {
    result.push(text.slice(lastIndex))
  }

  return result
}

export const MarkdownView: React.FC<MarkdownViewProps> = ({ content }) => {
  if (!content) return null

  const lines = content.split(/\r?\n/)
  const elements: ReactNode[] = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i]
    const trimmed = line.trim()

    // Empty line
    if (!trimmed) {
      i++
      continue
    }

    // Code block
    if (trimmed.startsWith('```')) {
      const lang = trimmed.slice(3).trim()
      const codeLines: string[] = []
      i++
      while (i < lines.length && !lines[i].trim().startsWith('```')) {
        codeLines.push(lines[i])
        i++
      }
      if (i < lines.length) i++ // skip closing fence
      elements.push(
        <pre
          key={`code-${i}`}
          style={{
            background: 'var(--surface-3)',
            padding: '10px 14px',
            borderRadius: 'var(--radius-sm)',
            overflowX: 'auto',
            fontFamily: 'var(--font-mono)',
            fontSize: '0.82rem',
            margin: 0,
            border: '1px solid var(--border)',
          }}
        >
          {lang && (
            <div style={{ color: 'var(--text-3)', fontSize: '0.72rem', marginBottom: 4 }}>
              {lang}
            </div>
          )}
          <code>{codeLines.join('\n')}</code>
        </pre>
      )
      continue
    }

    // Horizontal Rule
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      elements.push(
        <hr
          key={`hr-${i}`}
          style={{ border: 'none', borderTop: '1px solid var(--border-strong)', margin: '4px 0' }}
        />
      )
      i++
      continue
    }

    // Headings
    const hMatch = trimmed.match(/^(#{1,6})\s+(.*)$/)
    if (hMatch) {
      const level = hMatch[1].length
      const text = hMatch[2]
      const fontSize =
        level === 1 ? '1.12rem' : level === 2 ? '1.02rem' : level === 3 ? '0.95rem' : '0.9rem'
      elements.push(
        <div
          key={`h-${i}`}
          style={{
            fontWeight: 750,
            fontSize,
            margin: '4px 0 0',
            color: 'var(--text)',
            lineHeight: 1.35,
          }}
        >
          {renderInline(text, `h-${i}`)}
        </div>
      )
      i++
      continue
    }

    // Table
    if (trimmed.startsWith('|') && trimmed.endsWith('|')) {
      const tableLines: string[] = []
      while (i < lines.length && lines[i].trim().startsWith('|') && lines[i].trim().endsWith('|')) {
        tableLines.push(lines[i].trim())
        i++
      }

      let header: string[] | null = null
      let rows: string[][] = []

      if (tableLines.length >= 2 && /^\|[\s:|-]+\|$/.test(tableLines[1])) {
        header = tableLines[0]
          .slice(1, -1)
          .split('|')
          .map(s => s.trim())
        rows = tableLines.slice(2).map(r =>
          r
            .slice(1, -1)
            .split('|')
            .map(s => s.trim())
        )
      } else {
        rows = tableLines.map(r =>
          r
            .slice(1, -1)
            .split('|')
            .map(s => s.trim())
        )
      }

      elements.push(
        <div key={`table-${i}`} style={{ overflowX: 'auto', margin: '4px 0' }}>
          <table
            style={{
              width: '100%',
              borderCollapse: 'collapse',
              fontSize: '0.82rem',
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius-sm)',
            }}
          >
            {header && (
              <thead>
                <tr style={{ background: 'var(--surface-3)' }}>
                  {header.map((col, cIdx) => (
                    <th
                      key={cIdx}
                      style={{
                        padding: '6px 10px',
                        border: '1px solid var(--border)',
                        textAlign: 'left',
                        fontWeight: 700,
                        color: 'var(--text)',
                      }}
                    >
                      {renderInline(col, `th-${i}-${cIdx}`)}
                    </th>
                  ))}
                </tr>
              </thead>
            )}
            <tbody>
              {rows.map((row, rIdx) => (
                <tr
                  key={rIdx}
                  style={{
                    background:
                      rIdx % 2 === 1
                        ? 'color-mix(in srgb, var(--surface-2) 50%, transparent)'
                        : 'transparent',
                  }}
                >
                  {row.map((cell, cIdx) => (
                    <td
                      key={cIdx}
                      style={{
                        padding: '6px 10px',
                        border: '1px solid var(--border)',
                        verticalAlign: 'top',
                        lineHeight: 1.45,
                      }}
                    >
                      {renderInline(cell, `td-${i}-${rIdx}-${cIdx}`)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )
      continue
    }

    // Bullet List
    if (/^[*•-]\s+/.test(trimmed)) {
      const items: string[] = []
      while (i < lines.length && /^[*•-]\s+/.test(lines[i].trim())) {
        items.push(lines[i].trim().replace(/^[*•-]\s+/, ''))
        i++
      }
      elements.push(
        <ul key={`ul-${i}`} style={{ margin: '2px 0 2px 18px', padding: 0 }}>
          {items.map((item, idx) => (
            <li key={idx} style={{ margin: '2px 0', lineHeight: 1.5 }}>
              {renderInline(item, `ul-${i}-${idx}`)}
            </li>
          ))}
        </ul>
      )
      continue
    }

    // Numbered List
    if (/^\d+\.\s+/.test(trimmed)) {
      const items: string[] = []
      while (i < lines.length && /^\d+\.\s+/.test(lines[i].trim())) {
        items.push(lines[i].trim().replace(/^\d+\.\s+/, ''))
        i++
      }
      elements.push(
        <ol key={`ol-${i}`} style={{ margin: '2px 0 2px 20px', padding: 0 }}>
          {items.map((item, idx) => (
            <li key={idx} style={{ margin: '2px 0', lineHeight: 1.5 }}>
              {renderInline(item, `ol-${i}-${idx}`)}
            </li>
          ))}
        </ol>
      )
      continue
    }

    // Blockquote
    if (trimmed.startsWith('>')) {
      const quoteLines: string[] = []
      while (i < lines.length && lines[i].trim().startsWith('>')) {
        quoteLines.push(lines[i].trim().replace(/^>\s*/, ''))
        i++
      }
      elements.push(
        <blockquote
          key={`quote-${i}`}
          style={{
            borderLeft: '3px solid var(--accent)',
            margin: 0,
            padding: '4px 10px',
            color: 'var(--text-2)',
            fontStyle: 'italic',
            background: 'var(--surface-3)',
            borderRadius: '0 var(--radius-sm) var(--radius-sm) 0',
          }}
        >
          {quoteLines.map((ql, qIdx) => (
            <div key={qIdx}>{renderInline(ql, `q-${i}-${qIdx}`)}</div>
          ))}
        </blockquote>
      )
      continue
    }

    // Paragraph
    const pLines: string[] = []
    while (
      i < lines.length &&
      lines[i].trim() &&
      !lines[i].trim().startsWith('#') &&
      !lines[i].trim().startsWith('```') &&
      !lines[i].trim().startsWith('>') &&
      !(lines[i].trim().startsWith('|') && lines[i].trim().endsWith('|')) &&
      !/^[*•-]\s+/.test(lines[i].trim()) &&
      !/^\d+\.\s+/.test(lines[i].trim()) &&
      !/^(-{3,}|\*{3,}|_{3,})$/.test(lines[i].trim())
    ) {
      pLines.push(lines[i])
      i++
    }
    if (pLines.length > 0) {
      elements.push(
        <p key={`p-${i}`} style={{ margin: 0, lineHeight: 1.55 }}>
          {renderInline(pLines.join('\n'), `p-${i}`)}
        </p>
      )
    }
  }

  return <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>{elements}</div>
}
