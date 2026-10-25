import { Moon, PanelLeft, SquarePen, Sun, Terminal, Trash2 } from 'lucide-react'
import type { Conversation, Settings } from '../lib/types'
import { isLocalBaseUrl } from '../lib/format'

type Group = { label: string; items: Conversation[] }

function groupConversations(conversations: Conversation[]): Group[] {
  const now = new Date()
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const day = 86_400_000
  const buckets: Group[] = [
    { label: 'Today', items: [] },
    { label: 'Yesterday', items: [] },
    { label: 'Previous 7 days', items: [] },
    { label: 'Previous 30 days', items: [] },
    { label: 'Older', items: [] },
  ]

  for (const conversation of conversations) {
    const age = startOfToday - conversation.updatedAt
    if (age < 0) buckets[0].items.push(conversation)
    else if (age < day) buckets[1].items.push(conversation)
    else if (age < day * 7) buckets[2].items.push(conversation)
    else if (age < day * 30) buckets[3].items.push(conversation)
    else buckets[4].items.push(conversation)
  }

  return buckets.filter((bucket) => bucket.items.length > 0)
}

export function Sidebar({
  conversations,
  activeId,
  settings,
  open,
  theme,
  onSelect,
  onNew,
  onDelete,
  onOpenSettings,
  onToggleTheme,
  onClose,
}: {
  conversations: Conversation[]
  activeId: string
  settings: Settings
  open: boolean
  theme: 'light' | 'dark'
  onSelect: (id: string) => void
  onNew: () => void
  onDelete: (id: string) => void
  onOpenSettings: () => void
  onToggleTheme: () => void
  onClose: () => void
}) {
  const connected = settings.apiKey.trim() !== '' || isLocalBaseUrl(settings.baseUrl)
  const groups = groupConversations(conversations)

  return (
    <aside className={`sidebar ${open ? 'open' : ''}`}>
      <div className="sidebar-head">
        <div className="brand">
          <span className="brand-mark" aria-hidden>
            <Terminal size={14} strokeWidth={2.5} />
          </span>
          <span className="brand-text">
            <strong>Agent</strong>
            <small>your key</small>
          </span>
        </div>
        <div className="sidebar-head-actions">
          <button
            type="button"
            className="icon-btn theme-toggle"
            onClick={onToggleTheme}
            title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
            aria-label="Toggle theme"
          >
            {theme === 'dark' ? <Sun size={17} /> : <Moon size={17} />}
          </button>
          <button type="button" className="icon-btn sidebar-close" onClick={onClose} title="Close sidebar">
            <PanelLeft size={18} />
          </button>
        </div>
      </div>

      <button type="button" className="new-chat" onClick={onNew}>
        <SquarePen size={17} />
        <span>New chat</span>
      </button>

      <div className="conv-list">
        {groups.map((group) => (
          <div key={group.label}>
            <div className="conv-group-label">{group.label}</div>
            {group.items.map((conversation) => (
              <div
                key={conversation.id}
                className={`conv-item ${conversation.id === activeId ? 'active' : ''}`}
              >
                <button type="button" className="conv-main" onClick={() => onSelect(conversation.id)}>
                  <span className="conv-title">{conversation.title}</span>
                </button>
                <button
                  type="button"
                  className="conv-delete"
                  title="Delete chat"
                  aria-label={`Delete ${conversation.title}`}
                  onClick={(event) => {
                    event.stopPropagation()
                    onDelete(conversation.id)
                  }}
                >
                  <Trash2 size={13} />
                </button>
              </div>
            ))}
          </div>
        ))}
      </div>

      <div className="sidebar-foot">
        <button type="button" className="provider-card" onClick={onOpenSettings}>
          <span className="avatar" aria-hidden>
            {(settings.model || 'A').slice(0, 1).toUpperCase()}
            <span className={`status-dot ${connected ? 'on' : 'off'}`} />
          </span>
          <span className="provider-meta">
            <strong>{settings.model || 'No model selected'}</strong>
            <small>{connected ? 'Connected' : 'Add an API key'}</small>
          </span>
        </button>
      </div>
    </aside>
  )
}
