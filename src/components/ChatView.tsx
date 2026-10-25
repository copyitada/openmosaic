import { useEffect, useRef, useState } from 'react'
import { ArrowDown } from 'lucide-react'
import type { ChatMessage } from '../lib/types'
import { MessageRow } from './Message'

export function ChatView({
  messages,
  busy,
  streamingId,
  onRegenerate,
  children,
}: {
  messages: ChatMessage[]
  busy: boolean
  streamingId?: string
  onRegenerate: () => void
  children?: React.ReactNode
}) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const stickRef = useRef(true)
  const [showJump, setShowJump] = useState(false)

  const scrollToBottom = (behavior: ScrollBehavior = 'smooth') => {
    const node = containerRef.current
    if (!node) return
    node.scrollTo({ top: node.scrollHeight, behavior })
    stickRef.current = true
    setShowJump(false)
  }

  useEffect(() => {
    const node = containerRef.current
    if (!node) return
    if (stickRef.current) node.scrollTop = node.scrollHeight
  }, [messages, busy])

  const onScroll = () => {
    const node = containerRef.current
    if (!node) return
    const distance = node.scrollHeight - node.scrollTop - node.clientHeight
    stickRef.current = distance < 90
    setShowJump(distance > 240)
  }

  const lastAssistantId = [...messages].reverse().find((m) => m.role === 'assistant')?.id

  return (
    <div className="chat-area">
      <div className="chat-scroll" ref={containerRef} onScroll={onScroll}>
        <div className="chat-inner">
          {children}
          {messages.map((message) => (
            <MessageRow
              key={message.id}
              message={message}
              streaming={busy && message.id === streamingId}
              canRegenerate={!busy && message.id === lastAssistantId}
              onRegenerate={onRegenerate}
            />
          ))}
          <div className="chat-spacer" />
        </div>
      </div>
      {showJump ? (
        <button type="button" className="jump-btn" onClick={() => scrollToBottom()}>
          <ArrowDown size={14} /> Jump to latest
        </button>
      ) : null}
    </div>
  )
}
