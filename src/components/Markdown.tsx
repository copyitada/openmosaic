import { memo, useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import rehypeHighlight from 'rehype-highlight'
import remarkGfm from 'remark-gfm'
import { Check, Copy } from 'lucide-react'

function CodeBlock({ children }: { children?: ReactNode }) {
  const codeRef = useRef<HTMLElement | null>(null)
  const [copied, setCopied] = useState(false)

  const child = Array.isArray(children) ? children[0] : children
  const props = (child as ReactElement<{ className?: string; children?: ReactNode }> | null)?.props
  const className = props?.className ?? ''
  const language = /language-([\w+#.-]+)/.exec(className)?.[1]

  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 1600)
    return () => clearTimeout(timer)
  }, [copied])

  const copy = async () => {
    const text = codeRef.current?.innerText ?? ''
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
    } catch {
      /* clipboard blocked */
    }
  }

  return (
    <div className="code-block">
      <div className="code-block-head">
        <span className="code-lang">{language ?? 'text'}</span>
        <button type="button" className="code-copy" onClick={copy} aria-label="Copy code">
          {copied ? <Check size={13} /> : <Copy size={13} />}
          <span>{copied ? 'Copied' : 'Copy'}</span>
        </button>
      </div>
      <pre>
        <code ref={codeRef} className={className}>
          {props?.children}
        </code>
      </pre>
    </div>
  )
}

export const Markdown = memo(function Markdown({ content }: { content: string }) {
  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeHighlight, { detect: true, ignoreMissing: true }]]}
        components={{
          pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
          a: ({ children, href }) => (
            <a href={href} target="_blank" rel="noreferrer noopener">
              {children}
            </a>
          ),
          table: ({ children }) => (
            <div className="table-wrap">
              <table>{children}</table>
            </div>
          ),
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  )
})
