import { memo, useEffect, useState } from 'react'
import { Check, Copy, RotateCcw } from 'lucide-react'
import type { ChatMessage } from '../lib/types'
import { messageText } from '../lib/history'
import { Markdown } from './Markdown'
import { ToolCard } from './ToolCard'

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 1500)
    return () => clearTimeout(timer)
  }, [copied])
  return (
    <button
      type="button"
      className="msg-action"
      title={copied ? 'Copied' : 'Copy'}
      aria-label="Copy message"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text)
          setCopied(true)
        } catch {
          /* clipboard unavailable */
        }
      }}
    >
      {copied ? <Check size={15} /> : <Copy size={15} />}
    </button>
  )
}

export const MessageRow = memo(function MessageRow({
  message,
  streaming,
  canRegenerate,
  onRegenerate,
}: {
  message: ChatMessage
  streaming: boolean
  canRegenerate: boolean
  onRegenerate: () => void
}) {
  if (message.role === 'user') {
    return (
      <div className="msg-row user">
        <div className="bubble user-bubble">{messageText(message)}</div>
      </div>
    )
  }

  const thinking = streaming && message.parts.length === 0
  const hasRunningTool = message.parts.some((part) => part.type === 'tool' && part.status === 'running')
  const plainText = messageText(message)

  return (
    <div className="msg-row assistant">
      <div className="msg-body">
        {thinking ? (
          <div className="thinking">
            <span className="dot" />
            <span className="dot" />
            <span className="dot" />
            <span className="thinking-label">Thinking</span>
          </div>
        ) : null}

        {message.parts.map((part, index) => {
          if (part.type === 'text') {
            return (
              <div key={`text-${index}`} className="msg-text">
                <Markdown content={part.text} />
              </div>
            )
          }
          if (part.type === 'notice') {
            return (
              <div key={`notice-${index}`} className={`notice ${part.tone ?? 'info'}`}>
                {part.text}
              </div>
            )
          }
          return <ToolCard key={part.id} part={part} />
        })}

        {!streaming && (plainText || message.parts.length > 0) ? (
          <div className="msg-actions">
            {plainText ? <CopyButton text={plainText} /> : null}
            {canRegenerate ? (
              <button
                type="button"
                className="msg-action"
                title="Regenerate"
                aria-label="Regenerate"
                onClick={onRegenerate}
              >
                <RotateCcw size={15} />
              </button>
            ) : null}
            {hasRunningTool ? <span className="msg-action-hint">working…</span> : null}
          </div>
        ) : null}
      </div>
    </div>
  )
})
