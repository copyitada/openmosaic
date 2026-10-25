import { useEffect, useRef } from 'react'
import { ArrowUp, ChevronDown, FolderOpen, KeyRound, Square } from 'lucide-react'

export function Composer({
  value,
  onChange,
  onSend,
  onStop,
  onOpenFiles,
  onOpenSettings,
  busy,
  needsKey,
  model,
}: {
  value: string
  onChange: (value: string) => void
  onSend: () => void
  onStop: () => void
  onOpenFiles: () => void
  onOpenSettings: () => void
  busy: boolean
  needsKey: boolean
  model: string
}) {
  const ref = useRef<HTMLTextAreaElement | null>(null)

  useEffect(() => {
    const element = ref.current
    if (!element) return
    element.style.height = '0px'
    element.style.height = `${Math.min(240, element.scrollHeight)}px`
  }, [value])

  useEffect(() => {
    if (!busy) ref.current?.focus()
  }, [busy])

  const submit = () => {
    if (busy || !value.trim() || needsKey) return
    onSend()
  }

  return (
    <>
      <div className="composer">
        <textarea
          ref={ref}
          value={value}
          rows={1}
          placeholder="Ask anything"
          aria-label="Message"
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault()
              submit()
            }
          }}
        />
        <div className="composer-bar">
          <button
            type="button"
            className="composer-btn icon-only"
            onClick={onOpenFiles}
            title="Workspace files"
            aria-label="Workspace files"
          >
            <FolderOpen size={18} />
          </button>
          <div className="composer-actions">
            <button type="button" className="composer-btn" onClick={onOpenSettings} title="Model settings">
              <span>{model || 'Select model'}</span>
              <ChevronDown size={14} />
            </button>
            {busy ? (
              <button type="button" className="send-btn" onClick={onStop} title="Stop generating" aria-label="Stop">
                <Square size={11} fill="currentColor" />
              </button>
            ) : (
              <button
                type="button"
                className="send-btn"
                onClick={submit}
                disabled={!value.trim() || needsKey}
                title="Send"
                aria-label="Send"
              >
                <ArrowUp size={18} />
              </button>
            )}
          </div>
        </div>
      </div>
      {needsKey ? (
        <div className="composer-key-row">
          <button type="button" className="composer-key" onClick={onOpenSettings}>
            <KeyRound size={13} />
            Add your API key to start
          </button>
        </div>
      ) : null}
    </>
  )
}
