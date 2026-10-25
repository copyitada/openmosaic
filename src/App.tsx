import { useCallback, useEffect, useRef, useState } from 'react'
import { ChevronDown, FolderOpen, PanelLeft, Settings2 } from 'lucide-react'
import { ChatView } from './components/ChatView'
import { Composer } from './components/Composer'
import { EmptyState } from './components/EmptyState'
import { FilePanel } from './components/FilePanel'
import { SettingsDialog } from './components/SettingsDialog'
import { Sidebar } from './components/Sidebar'
import { streamChat } from './lib/api'
import { isLocalBaseUrl } from './lib/format'
import { toWireMessages } from './lib/history'
import {
  createConversation,
  loadConversations,
  loadSettings,
  loadTheme,
  saveConversations,
  saveSettings,
  saveTheme,
  uid,
} from './lib/storage'
import type { AgentEvent, ChatMessage, Conversation, Part, Settings, WireMessage } from './lib/types'

const LIVE_OUTPUT_CAP = 60_000

function titleFrom(text: string): string {
  const clean = text.replace(/\s+/g, ' ').trim()
  if (!clean) return 'New chat'
  return clean.length > 52 ? `${clean.slice(0, 52)}…` : clean
}

function applyEventToParts(parts: Part[], event: AgentEvent): Part[] {
  switch (event.type) {
    case 'text': {
      const next = [...parts]
      const last = next[next.length - 1]
      if (last && last.type === 'text') {
        next[next.length - 1] = { ...last, text: last.text + event.text }
      } else {
        next.push({ type: 'text', text: event.text })
      }
      return next
    }
    case 'tool_start':
      return [
        ...parts,
        {
          type: 'tool',
          id: event.id,
          name: event.name,
          args: (event.args ?? {}) as Record<string, unknown>,
          status: 'running',
          output: '',
        },
      ]
    case 'tool_progress':
      return parts.map((part) =>
        part.type === 'tool' && part.id === event.id
          ? { ...part, output: (part.output + event.chunk).slice(-LIVE_OUTPUT_CAP) }
          : part,
      )
    case 'tool_end':
      return parts.map((part) =>
        part.type === 'tool' && part.id === event.id
          ? {
              ...part,
              status: event.ok ? 'ok' : 'error',
              output: event.output,
              meta: event.meta,
              durationMs: event.durationMs,
            }
          : part,
      )
    case 'notice':
      return [...parts, { type: 'notice', text: event.text }]
    case 'error':
      return [...parts, { type: 'notice', text: event.message, tone: 'error' }]
    default:
      return parts
  }
}

export default function App() {
  const [conversations, setConversations] = useState<Conversation[]>(() => {
    const loaded = loadConversations()
    return loaded.length > 0 ? loaded : [createConversation()]
  })
  const [activeId, setActiveId] = useState<string>(() => conversations[0].id)
  const [settings, setSettings] = useState<Settings>(loadSettings)
  const [theme, setTheme] = useState<'light' | 'dark'>(loadTheme)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [streamingId, setStreamingId] = useState<string | undefined>(undefined)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [panelOpen, setPanelOpen] = useState(false)
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [treeVersion, setTreeVersion] = useState(0)
  const abortRef = useRef<AbortController | null>(null)

  const active = conversations.find((conversation) => conversation.id === activeId) ?? conversations[0]
  const needsKey = settings.apiKey.trim() === '' && !isLocalBaseUrl(settings.baseUrl)
  const isEmpty = active.messages.length === 0

  useEffect(() => {
    const timer = setTimeout(() => saveConversations(conversations), 250)
    return () => clearTimeout(timer)
  }, [conversations])

  useEffect(() => {
    saveSettings(settings)
  }, [settings])

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    saveTheme(theme)
  }, [theme])

  // Narrow screens open with the transcript, not a drawer over it.
  useEffect(() => {
    if (window.innerWidth <= 780) setSidebarOpen(false)
  }, [])

  const applyEvent = useCallback((convId: string, messageId: string, event: AgentEvent) => {
    setConversations((prev) =>
      prev.map((conversation) => {
        if (conversation.id !== convId) return conversation
        return {
          ...conversation,
          updatedAt: Date.now(),
          messages: conversation.messages.map((message) =>
            message.id === messageId
              ? { ...message, parts: applyEventToParts(message.parts, event) }
              : message,
          ),
        }
      }),
    )
  }, [])

  const settleRunningTools = useCallback((convId: string, messageId: string, note: string) => {
    setConversations((prev) =>
      prev.map((conversation) => {
        if (conversation.id !== convId) return conversation
        return {
          ...conversation,
          messages: conversation.messages.map((message) => {
            if (message.id !== messageId) return message
            return {
              ...message,
              parts: message.parts.map((part) =>
                part.type === 'tool' && part.status === 'running'
                  ? { ...part, status: 'error', output: part.output ? `${part.output}\n${note}` : note }
                  : part,
              ),
            }
          }),
        }
      }),
    )
  }, [])

  const runTurn = useCallback(
    async (convId: string, workspaceId: string, history: WireMessage[], assistantId: string) => {
      const controller = new AbortController()
      abortRef.current = controller
      setBusy(true)
      setStreamingId(assistantId)

      try {
        await streamChat(
          { workspaceId, messages: history, provider: settings },
          { signal: controller.signal, onEvent: (event) => applyEvent(convId, assistantId, event) },
        )
      } catch (error) {
        const aborted = controller.signal.aborted
        applyEvent(convId, assistantId, {
          type: 'notice',
          text: aborted
            ? 'Stopped.'
            : `Request failed: ${(error as Error).message || 'unknown error'}`,
          tone: aborted ? 'info' : 'error',
        })
      } finally {
        if (controller.signal.aborted) settleRunningTools(convId, assistantId, 'Stopped.')
        abortRef.current = null
        setBusy(false)
        setStreamingId(undefined)
        setTreeVersion((value) => value + 1)
      }
    },
    [applyEvent, settleRunningTools, settings],
  )

  const send = useCallback(
    async (raw?: string) => {
      const text = (raw ?? draft).trim()
      if (!text || busy) return
      if (needsKey) {
        setSettingsOpen(true)
        return
      }

      setDraft('')
      const conversation = active
      const now = Date.now()
      const userMessage: ChatMessage = {
        id: uid(),
        role: 'user',
        parts: [{ type: 'text', text }],
        createdAt: now,
      }
      const assistantMessage: ChatMessage = {
        id: uid(),
        role: 'assistant',
        parts: [],
        createdAt: now + 1,
      }
      const history = toWireMessages([...conversation.messages, userMessage])

      setConversations((prev) =>
        prev.map((item) =>
          item.id === conversation.id
            ? {
                ...item,
                title: item.title === 'New chat' ? titleFrom(text) : item.title,
                messages: [...item.messages, userMessage, assistantMessage],
                updatedAt: now,
              }
            : item,
        ),
      )

      await runTurn(conversation.id, conversation.workspaceId, history, assistantMessage.id)
    },
    [active, busy, draft, needsKey, runTurn],
  )

  const regenerate = useCallback(async () => {
    if (busy) return
    const conversation = active
    const messages = [...conversation.messages]
    let lastAssistant = -1
    for (let index = messages.length - 1; index >= 0; index--) {
      if (messages[index].role === 'assistant') {
        lastAssistant = index
        break
      }
    }
    if (lastAssistant < 0) return
    const trimmed = messages.slice(0, lastAssistant)
    const assistantMessage: ChatMessage = {
      id: uid(),
      role: 'assistant',
      parts: [],
      createdAt: Date.now(),
    }
    setConversations((prev) =>
      prev.map((item) =>
        item.id === conversation.id
          ? { ...item, messages: [...trimmed, assistantMessage], updatedAt: Date.now() }
          : item,
      ),
    )
    await runTurn(conversation.id, conversation.workspaceId, toWireMessages(trimmed), assistantMessage.id)
  }, [active, busy, runTurn])

  const newChat = useCallback(() => {
    const conversation = createConversation()
    setConversations((prev) => [conversation, ...prev])
    setActiveId(conversation.id)
    setDraft('')
    setBusy(false)
    setPanelOpen(false)
  }, [])

  const deleteConversation = (id: string) => {
    if (id === activeId) abortRef.current?.abort()
    const remaining = conversations.filter((conversation) => conversation.id !== id)
    if (remaining.length === 0) {
      const fresh = createConversation()
      setConversations([fresh])
      setActiveId(fresh.id)
      return
    }
    setConversations(remaining)
    if (id === activeId) setActiveId(remaining[0].id)
  }

  const stop = () => {
    abortRef.current?.abort()
    setBusy(false)
  }

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        newChat()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [newChat])

  const composer = (
    <Composer
      value={draft}
      onChange={setDraft}
      onSend={() => void send()}
      onStop={stop}
      onOpenFiles={() => setPanelOpen((value) => !value)}
      onOpenSettings={() => setSettingsOpen(true)}
      busy={busy}
      needsKey={needsKey}
      model={settings.model}
    />
  )

  return (
    <div className={`app ${sidebarOpen ? 'sidebar-open' : 'sidebar-closed'} ${panelOpen ? 'panel-open' : ''}`}>
      <Sidebar
        conversations={conversations}
        activeId={active.id}
        settings={settings}
        open={sidebarOpen}
        theme={theme}
        onSelect={setActiveId}
        onNew={newChat}
        onDelete={deleteConversation}
        onOpenSettings={() => setSettingsOpen(true)}
        onToggleTheme={() => setTheme((value) => (value === 'dark' ? 'light' : 'dark'))}
        onClose={() => setSidebarOpen(false)}
      />
      {sidebarOpen ? <div className="scrim" onClick={() => setSidebarOpen(false)} /> : null}

      <main className="main">
        <header className="topbar">
          {sidebarOpen ? null : (
            <button
              type="button"
              className="icon-btn"
              onClick={() => setSidebarOpen(true)}
              title="Open sidebar"
              aria-label="Open sidebar"
            >
              <PanelLeft size={18} />
            </button>
          )}
          <button
            type="button"
            className="topbar-model"
            onClick={() => setSettingsOpen(true)}
            title="Model settings"
          >
            <span>{settings.model || 'Select a model'}</span>
            <ChevronDown size={15} />
          </button>
          <div className="topbar-actions">
            <button
              type="button"
              className={`icon-btn ${panelOpen ? 'active' : ''}`}
              onClick={() => setPanelOpen((value) => !value)}
              title="Workspace files"
              aria-label="Workspace files"
            >
              <FolderOpen size={17} />
            </button>
            <button
              type="button"
              className="icon-btn"
              onClick={() => setSettingsOpen(true)}
              title="Settings"
              aria-label="Settings"
            >
              <Settings2 size={17} />
            </button>
          </div>
        </header>

        {isEmpty ? (
          <div className="composer-dock centered">
            <div className="composer-inner">
              <EmptyState onPick={(prompt) => void send(prompt)}>
                {composer}
                <div className="composer-note">
                  The agent can read and write files and run shell commands in this workspace.
                </div>
              </EmptyState>
            </div>
          </div>
        ) : (
          <>
            <ChatView
              messages={active.messages}
              busy={busy}
              streamingId={streamingId}
              onRegenerate={regenerate}
            />
            <div className="composer-dock">
              <div className="composer-inner">
                {composer}
                <div className="composer-note">
                  The agent can read and write files and run shell commands in this workspace.
                </div>
              </div>
            </div>
          </>
        )}
      </main>

      {panelOpen ? (
        <FilePanel
          workspaceId={active.workspaceId}
          version={treeVersion}
          onClose={() => setPanelOpen(false)}
          onMutated={() => setTreeVersion((value) => value + 1)}
        />
      ) : null}

      {settingsOpen ? (
        <SettingsDialog
          settings={settings}
          onSave={(next) => setSettings(next)}
          onClose={() => setSettingsOpen(false)}
        />
      ) : null}
    </div>
  )
}
