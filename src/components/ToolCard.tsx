import { useEffect, useRef, useState } from 'react'
import {
  AlertTriangle,
  Check,
  ChevronDown,
  FilePlus2,
  FileText,
  FolderTree,
  Loader2,
  PencilLine,
  Terminal,
} from 'lucide-react'
import type { ToolPart } from '../lib/types'
import { formatDuration, toolLabel } from '../lib/format'

const icons = {
  run_command: Terminal,
  write_file: FilePlus2,
  edit_file: PencilLine,
  read_file: FileText,
  list_files: FolderTree,
} as const

function targetOf(part: ToolPart): string {
  const args = part.args ?? {}
  if (part.name === 'run_command') return String(args.command ?? '')
  if (typeof args.path === 'string') return args.path
  return ''
}

function StatusBadge({ status }: { status: ToolPart['status'] }) {
  if (status === 'running') {
    return (
      <span className="tool-status running">
        <Loader2 size={11} className="spin" /> running
      </span>
    )
  }
  if (status === 'error') {
    return (
      <span className="tool-status error">
        <AlertTriangle size={11} /> failed
      </span>
    )
  }
  return (
    <span className="tool-status ok">
      <Check size={11} /> done
    </span>
  )
}

export function ToolCard({ part }: { part: ToolPart }) {
  const Icon = icons[part.name as keyof typeof icons] ?? Terminal
  const target = targetOf(part)
  const [open, setOpen] = useState(
    () => part.status === 'running' || part.status === 'error' || part.output.length < 700,
  )
  const bodyRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (part.status === 'error') setOpen(true)
  }, [part.status])

  useEffect(() => {
    if (!open || part.name !== 'run_command') return
    const node = bodyRef.current?.querySelector('.tool-output')
    if (node) node.scrollTop = node.scrollHeight
  }, [part.output, open, part.name])

  const args = part.args ?? {}
  const meta = part.meta ?? {}

  let body: React.ReactNode = null
  if (part.name === 'write_file') {
    const content = typeof args.content === 'string' ? args.content : ''
    const lines = content.split('\n').slice(0, 80).join('\n')
    body = (
      <>
        <pre className="tool-output code">{content === '' ? '(empty file)' : lines}</pre>
        {content.split('\n').length > 80 ? (
          <div className="tool-more">… {content.split('\n').length - 80} more lines</div>
        ) : null}
        {typeof meta.lines === 'number' ? (
          <div className="tool-foot">{String(meta.lines)} lines written</div>
        ) : null}
      </>
    )
  } else if (part.name === 'edit_file') {
    body = (
      <>
        <div className="diff">
          <div className="diff-line removed">
            <span className="diff-sign">−</span>
            <span>{String(args.find ?? '')}</span>
          </div>
          <div className="diff-line added">
            <span className="diff-sign">+</span>
            <span>{String(args.replace ?? '')}</span>
          </div>
        </div>
        <div className="tool-foot">{part.output}</div>
      </>
    )
  } else {
    body = (
      <>
        <pre className="tool-output">{part.output || (part.status === 'running' ? '' : '(no output)')}</pre>
        {part.status === 'running' ? <div className="tool-caret" /> : null}
      </>
    )
  }

  return (
    <div className={`tool-card ${part.status}`} ref={bodyRef}>
      <button type="button" className="tool-head" onClick={() => setOpen((value) => !value)}>
        <span className={`tool-icon ${part.name}`}>
          <Icon size={13} />
        </span>
        <span className="tool-label">{toolLabel(part.name)}</span>
        {target ? (
          <code className={`tool-target ${part.name === 'run_command' ? 'command' : ''}`}>
            {part.name === 'run_command' ? `$ ${target}` : target}
          </code>
        ) : null}
        <span className="tool-meta">
          {part.durationMs !== undefined ? (
            <span className="tool-time">{formatDuration(part.durationMs)}</span>
          ) : null}
          <StatusBadge status={part.status} />
          <ChevronDown size={13} className={`chevron ${open ? 'open' : ''}`} />
        </span>
      </button>
      {open ? <div className="tool-body">{body}</div> : null}
    </div>
  )
}
