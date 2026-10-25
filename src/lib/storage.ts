import type { Conversation, Settings } from './types'

const CONVERSATIONS_KEY = 'byok-agent.conversations.v1'
const SETTINGS_KEY = 'byok-agent.settings.v1'
const THEME_KEY = 'byok-agent.theme.v1'
const MAX_CONVERSATIONS = 40

export const defaultSettings: Settings = {
  apiKey: '',
  baseUrl: 'https://api.openai.com/v1',
  model: 'gpt-4o-mini',
  maxSteps: 16,
}

export function uid(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID()
  return `id_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`
}

export function createConversation(): Conversation {
  const now = Date.now()
  return {
    id: uid(),
    workspaceId: `ws-${uid().slice(0, 8)}`,
    title: 'New chat',
    messages: [],
    createdAt: now,
    updatedAt: now,
  }
}

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY)
    if (!raw) return { ...defaultSettings }
    const parsed = JSON.parse(raw) as Partial<Settings>
    return {
      apiKey: typeof parsed.apiKey === 'string' ? parsed.apiKey : '',
      baseUrl: typeof parsed.baseUrl === 'string' && parsed.baseUrl ? parsed.baseUrl : defaultSettings.baseUrl,
      model: typeof parsed.model === 'string' && parsed.model ? parsed.model : defaultSettings.model,
      maxSteps: typeof parsed.maxSteps === 'number' && parsed.maxSteps > 0 ? parsed.maxSteps : defaultSettings.maxSteps,
    }
  } catch {
    return { ...defaultSettings }
  }
}

export function saveSettings(settings: Settings): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings))
  } catch {
    /* storage full or unavailable */
  }
}

export function loadTheme(): 'light' | 'dark' {
  try {
    const stored = localStorage.getItem(THEME_KEY)
    if (stored === 'light' || stored === 'dark') return stored
  } catch {
    /* storage unavailable */
  }
  if (typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: light)').matches) {
    return 'light'
  }
  return 'dark'
}

export function saveTheme(theme: 'light' | 'dark'): void {
  try {
    localStorage.setItem(THEME_KEY, theme)
  } catch {
    /* storage unavailable */
  }
}

export function loadConversations(): Conversation[] {
  try {
    const raw = localStorage.getItem(CONVERSATIONS_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter((c): c is Conversation => Boolean(c && typeof c === 'object' && 'id' in c && 'messages' in c))
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, MAX_CONVERSATIONS)
  } catch {
    return []
  }
}

export function saveConversations(conversations: Conversation[]): void {
  try {
    const trimmed = [...conversations]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, MAX_CONVERSATIONS)
    localStorage.setItem(CONVERSATIONS_KEY, JSON.stringify(trimmed))
  } catch {
    /* storage full — keep the session usable */
  }
}
