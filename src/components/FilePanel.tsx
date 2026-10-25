import { useEffect, useMemo, useState } from 'react'
import {
  ArrowLeft,
  Download,
  File as FileIcon,
  FileText,
  Folder,
  Loader2,
  RefreshCw,
  Trash2,
  X,
} from 'lucide-react'
import { downloadUrl, fetchFile, fetchTree, resetWorkspace } from '../lib/api'
import { formatBytes } from '../lib/format'
import type { FilePayload, TreeEntry } from '../lib/types'

const PREVIEW_LINE_LIMIT = 2500

export function FilePanel({
  workspaceId,
  version,
  onClose,
  onMutated,
}: {
  workspaceId: string
  version: number
  onClose: () => void
  onMutated: () => void
}) {
  const [entries, setEntries] = useState<TreeEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<FilePayload | null>(null)
  const [fileLoading, setFileLoading] = useState(false)

  const load = async () => {
    setLoading(true)
    try {
      const next = await fetchTree(workspaceId)
      setEntries(next)
      setError(null)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, version])

  useEffect(() => {
    setSelected(null)
  }, [workspaceId])

  const openFile = async (path: string) => {
    setFileLoading(true)
    try {
      const payload = await fetchFile(workspaceId, path)
      setSelected(payload)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setFileLoading(false)
    }
  }

  const lines = useMemo(() => {
    if (!selected || selected.binary) return []
    return selected.content.split('\n').slice(0, PREVIEW_LINE_LIMIT)
  }, [selected])

  const totalFiles = entries.filter((entry) => entry.type === 'file').length

  return (
    <aside className="file-panel">
      <div className="file-panel-head">
        {selected ? (
          <button type="button" className="icon-btn" onClick={() => setSelected(null)} title="Back to files">
            <ArrowLeft size={16} />
          </button>
        ) : (
          <span className="file-panel-title">
            <Folder size={14} /> Workspace
          </span>
        )}
        {selected ? <span className="file-path mono">{selected.path}</span> : null}
        <div className="file-panel-actions">
          {selected ? (
            <a
              className="icon-btn"
              href={downloadUrl(workspaceId, selected.path)}
              title="Download file"
              download
            >
              <Download size={15} />
            </a>
          ) : null}
          <button type="button" className="icon-btn" onClick={() => void load()} title="Refresh">
            <RefreshCw size={15} className={loading ? 'spin' : ''} />
          </button>
          <button
            type="button"
            className="icon-btn danger"
            title="Delete all workspace files"
            onClick={async () => {
              if (!window.confirm('Delete every file in this chat’s workspace? This cannot be undone.')) return
              await resetWorkspace(workspaceId)
              setSelected(null)
              await load()
              onMutated()
            }}
          >
            <Trash2 size={15} />
          </button>
          <button type="button" className="icon-btn" onClick={onClose} title="Close panel">
            <X size={16} />
          </button>
        </div>
      </div>

      {error ? <div className="file-panel-error">{error}</div> : null}

      <div className="file-panel-body">
        {selected ? (
          <div className="file-preview">
            <div className="file-preview-meta">
              <span>{formatBytes(selected.size)}</span>
              {selected.truncated ? <span className="warn">showing first 400 KB</span> : null}
              {selected.binary ? <span className="warn">binary file</span> : null}
            </div>
            {selected.binary ? (
              <div className="file-empty">Binary file — download it to inspect.</div>
            ) : (
              <div className="code-view">
                {lines.map((line, index) => (
                  <div className="code-line" key={index}>
                    <span className="ln">{index + 1}</span>
                    <span className="lc">{line || ' '}</span>
                  </div>
                ))}
                {selected.content.split('\n').length > PREVIEW_LINE_LIMIT ? (
                  <div className="code-line muted">
                    … preview truncated at {PREVIEW_LINE_LIMIT} lines
                  </div>
                ) : null}
              </div>
            )}
          </div>
        ) : (
          <>
            <div className="file-panel-sub">{loading ? 'Loading…' : `${totalFiles} files`}</div>
            {entries.length === 0 && !loading ? (
              <div className="file-empty">
                <FileText size={20} />
                <p>The workspace is empty.</p>
                <span>Ask the agent to create something and it will appear here.</span>
              </div>
            ) : (
              <div className="file-list">
                {entries.map((entry) => {
                  const depth = entry.path.split('/').length - 1
                  const name = entry.path.split('/').pop() ?? entry.path
                  return entry.type === 'dir' ? (
                    <div className="file-row dir" key={entry.path} style={{ paddingLeft: 10 + depth * 14 }}>
                      <Folder size={13} />
                      <span>{name}</span>
                    </div>
                  ) : (
                    <button
                      type="button"
                      className="file-row"
                      key={entry.path}
                      style={{ paddingLeft: 10 + depth * 14 }}
                      onClick={() => void openFile(entry.path)}
                    >
                      <FileIcon size={13} />
                      <span>{name}</span>
                      <small>{formatBytes(entry.size)}</small>
                    </button>
                  )
                })}
              </div>
            )}
            {fileLoading ? <div className="file-loading"><Loader2 size={14} className="spin" /></div> : null}
          </>
        )}
      </div>
    </aside>
  )
}
