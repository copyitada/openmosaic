export type TextPart = { type: 'text'; text: string }
export type NoticePart = { type: 'notice'; text: string; tone?: 'info' | 'error' }
export type ToolPart = {
  type: 'tool'
  id: string
  name: string
  args: Record<string, unknown>
  status: 'running' | 'ok' | 'error'
  output: string
  meta?: Record<string, unknown>
  durationMs?: number
}
export type Part = TextPart | NoticePart | ToolPart

export type ChatMessage = {
  id: string
  role: 'user' | 'assistant'
  parts: Part[]
  createdAt: number
}

export type Conversation = {
  id: string
  workspaceId: string
  title: string
  messages: ChatMessage[]
  createdAt: number
  updatedAt: number
}

export type Settings = {
  apiKey: string
  baseUrl: string
  model: string
  maxSteps: number
}

export type WireMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | null
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>
  tool_call_id?: string
}

export type AgentEvent =
  | { type: 'text'; text: string }
  | { type: 'tool_start'; id: string; name: string; args: unknown; step: number }
  | { type: 'tool_progress'; id: string; chunk: string; stream: 'stdout' | 'stderr' }
  | {
      type: 'tool_end'
      id: string
      ok: boolean
      output: string
      meta?: Record<string, unknown>
      durationMs: number
    }
  | { type: 'notice'; text: string; tone?: 'info' | 'error' }
  | { type: 'done'; steps: number; elapsedMs: number }
  | { type: 'error'; message: string }

export type TreeEntry = { path: string; type: 'file' | 'dir'; size?: number }

export type FilePayload = {
  path: string
  content: string
  truncated: boolean
  binary: boolean
  size: number
}
