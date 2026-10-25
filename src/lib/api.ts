import type { AgentEvent, FilePayload, Settings, TreeEntry, WireMessage } from './types'

export class ApiError extends Error {}

async function describeFailure(response: Response): Promise<string> {
  const text = await response.text().catch(() => '')
  if (!text) return `Request failed with HTTP ${response.status}.`
  try {
    const parsed = JSON.parse(text) as { error?: string; message?: string }
    return parsed.error ?? parsed.message ?? text
  } catch {
    return text.slice(0, 500)
  }
}

export async function streamChat(
  input: { workspaceId: string; messages: WireMessage[]; provider: Settings },
  handlers: { signal: AbortSignal; onEvent: (event: AgentEvent) => void },
): Promise<void> {
  const response = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
    signal: handlers.signal,
  })

  if (!response.ok) throw new ApiError(await describeFailure(response))
  if (!response.body) throw new ApiError('The server returned an empty stream.')

  const contentType = response.headers.get('content-type') ?? ''
  if (!contentType.includes('text/event-stream')) {
    throw new ApiError(await describeFailure(response))
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      let boundary = buffer.indexOf('\n\n')
      while (boundary !== -1) {
        const block = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)
        const payload = block
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trim())
          .join('')
        if (payload) {
          try {
            handlers.onEvent(JSON.parse(payload) as AgentEvent)
          } catch {
            /* ignore malformed frame */
          }
        }
        boundary = buffer.indexOf('\n\n')
      }
    }
  } finally {
    try {
      await reader.cancel()
    } catch {
      /* already closed */
    }
  }
}

export async function fetchTree(workspaceId: string): Promise<TreeEntry[]> {
  const response = await fetch(`/api/workspace/${encodeURIComponent(workspaceId)}/tree`)
  if (!response.ok) throw new ApiError(await describeFailure(response))
  const data = (await response.json()) as { entries: TreeEntry[] }
  return data.entries
}

export async function fetchFile(workspaceId: string, filePath: string): Promise<FilePayload> {
  const response = await fetch(
    `/api/workspace/${encodeURIComponent(workspaceId)}/file?path=${encodeURIComponent(filePath)}`,
  )
  if (!response.ok) throw new ApiError(await describeFailure(response))
  return (await response.json()) as FilePayload
}

export async function resetWorkspace(workspaceId: string): Promise<void> {
  const response = await fetch(`/api/workspace/${encodeURIComponent(workspaceId)}`, { method: 'DELETE' })
  if (!response.ok) throw new ApiError(await describeFailure(response))
}

export function downloadUrl(workspaceId: string, filePath: string): string {
  return `/api/workspace/${encodeURIComponent(workspaceId)}/download?path=${encodeURIComponent(filePath)}`
}

export async function testProvider(
  provider: Settings,
): Promise<{ ok: boolean; message: string; elapsedMs?: number; reply?: string }> {
  try {
    const response = await fetch('/api/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider }),
    })
    return (await response.json()) as { ok: boolean; message: string; elapsedMs?: number }
  } catch (error) {
    return { ok: false, message: (error as Error).message }
  }
}
