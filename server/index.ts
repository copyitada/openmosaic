import express, { type Request, type Response } from 'express'
import fs from 'node:fs/promises'
import http from 'node:http'
import path from 'node:path'
import { runAgent, type AgentEvent, type ProviderConfig, type WireMessage } from './agent'
import { HttpError, PROJECT_ROOT, resolveInWorkspace, workspaceDir } from './paths'
import { buildSystemPrompt } from './prompt'
import { collectTree } from './tools'

const PORT = Number(process.env.PORT ?? 3000)
const IS_PROD = process.env.NODE_ENV === 'production'

const app = express()
app.disable('x-powered-by')
app.use(express.json({ limit: '20mb' }))

/* ------------------------------------------------------------- utilities */

function readProvider(input: unknown): ProviderConfig {
  const raw = (input ?? {}) as Record<string, unknown>
  const baseUrl = typeof raw.baseUrl === 'string' ? raw.baseUrl.trim() : ''
  const model = typeof raw.model === 'string' ? raw.model.trim() : ''
  const apiKey = typeof raw.apiKey === 'string' ? raw.apiKey.trim() : ''
  if (!baseUrl) throw new HttpError(400, 'No provider base URL configured. Open Settings and add one.')
  if (!/^https?:\/\//i.test(baseUrl)) throw new HttpError(400, 'The provider base URL must start with http:// or https://')
  if (!model) throw new HttpError(400, 'No model configured. Open Settings and choose a model.')
  return {
    apiKey,
    baseUrl,
    model,
    maxSteps: typeof raw.maxSteps === 'number' ? raw.maxSteps : undefined,
  }
}

function sseWrite(res: Response, event: AgentEvent): void {
  if (res.writableEnded) return
  try {
    res.write(`data: ${JSON.stringify(event)}\n\n`)
  } catch {
    /* client went away */
  }
}

/** Keep the transcript inside a sane context window and free of orphaned tool messages. */
function sanitizeHistory(input: unknown, characterBudget = 220_000): WireMessage[] {
  if (!Array.isArray(input)) return []
  const messages: WireMessage[] = []

  for (const item of input) {
    if (!item || typeof item !== 'object') continue
    const row = item as Record<string, unknown>
    const role = row.role
    if (role !== 'user' && role !== 'assistant' && role !== 'tool') continue
    const content = typeof row.content === 'string' ? row.content : ''
    if (role === 'tool') {
      if (typeof row.tool_call_id !== 'string' || !row.tool_call_id) continue
      messages.push({ role, content, tool_call_id: row.tool_call_id })
      continue
    }
    if (role === 'assistant' && Array.isArray(row.tool_calls) && row.tool_calls.length > 0) {
      const toolCalls = (row.tool_calls as any[])
        .filter((call) => call && call.function?.name)
        .map((call, index) => ({
          id: typeof call.id === 'string' && call.id ? call.id : `call_${index}`,
          type: 'function' as const,
          function: {
            name: String(call.function.name),
            arguments:
              typeof call.function.arguments === 'string'
                ? call.function.arguments
                : JSON.stringify(call.function.arguments ?? {}),
          },
        }))
      messages.push({ role: 'assistant', content, tool_calls: toolCalls })
      continue
    }
    if (!content.trim()) continue
    messages.push({ role, content })
  }

  // Drop orphaned tool results (no matching assistant call) — providers reject those.
  const cleaned: WireMessage[] = []
  for (const message of messages) {
    if (message.role === 'tool') {
      const previous = cleaned[cleaned.length - 1]
      const owner = cleaned.findLast?.((m) => m.role === 'assistant' && m.tool_calls?.some((c) => c.id === message.tool_call_id))
      if (!owner) continue
      if (previous?.role === 'user') continue
    }
    cleaned.push(message)
  }

  // Trim from the front, always on a user boundary, so the turn stays coherent.
  let total = cleaned.reduce((sum, m) => sum + (m.content?.length ?? 0), 0)
  let start = 0
  while (total > characterBudget && start < cleaned.length - 1) {
    let next = start
    while (next < cleaned.length - 1 && cleaned[next].role !== 'user') {
      total -= cleaned[next].content?.length ?? 0
      next++
    }
    if (next === start) break
    start = next
  }

  const sliced = cleaned.slice(start)
  while (sliced.length > 0 && sliced[0].role !== 'user') sliced.shift()
  return sliced
}

/* ------------------------------------------------------------------ chat */

app.post('/api/chat', async (req: Request, res: Response) => {
  let provider: ProviderConfig
  let root: string
  let history: WireMessage[]
  try {
    provider = readProvider(req.body?.provider)
    root = workspaceDir(req.body?.workspaceId)
    history = sanitizeHistory(req.body?.messages)
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 400
    res.status(status).json({ error: (error as Error).message })
    return
  }

  await fs.mkdir(root, { recursive: true })

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-store, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  })
  res.flushHeaders?.()

  const controller = new AbortController()
  const onClose = () => {
    if (!res.writableEnded) controller.abort()
  }
  res.on('close', onClose)

  const heartbeat = setInterval(() => {
    if (!res.writableEnded) res.write(': keepalive\n\n')
  }, 15_000)

  const messages: WireMessage[] = [
    {
      role: 'system',
      content: buildSystemPrompt({
        workspacePath: root,
        platform: `${process.platform} (${process.arch})`,
      }),
    },
    ...history,
  ]

  try {
    await runAgent({
      provider,
      messages,
      workspaceRoot: root,
      signal: controller.signal,
      emit: (event) => sseWrite(res, event),
    })
  } catch (error) {
    sseWrite(res, { type: 'error', message: (error as Error).message ?? 'Unknown agent failure.' })
  } finally {
    clearInterval(heartbeat)
    res.off('close', onClose)
    if (!res.writableEnded) res.end()
  }
})

/** Tiny non-streaming round trip so users can verify a key before chatting. */
app.post('/api/test', async (req: Request, res: Response) => {
  let provider: ProviderConfig
  try {
    provider = readProvider(req.body?.provider)
  } catch (error) {
    res.status(400).json({ ok: false, message: (error as Error).message })
    return
  }

  const url = (() => {
    const base = provider.baseUrl.replace(/\/+$/, '')
    return /\/chat\/completions$/i.test(base) ? base : `${base}/chat/completions`
  })()

  const startedAt = Date.now()
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(provider.apiKey ? { Authorization: `Bearer ${provider.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: provider.model,
        messages: [{ role: 'user', content: 'Reply with the single word: ready' }],
        max_tokens: 8,
        stream: false,
      }),
      signal: AbortSignal.timeout(20_000),
    })
    const text = await response.text()
    const elapsedMs = Date.now() - startedAt
    if (!response.ok) {
      res.json({ ok: false, message: `HTTP ${response.status} — ${text.slice(0, 300)}` })
      return
    }
    let reply = ''
    try {
      const json = JSON.parse(text)
      reply = json?.choices?.[0]?.message?.content ?? ''
    } catch {
      reply = text.slice(0, 120)
    }
    res.json({ ok: true, elapsedMs, message: `Connected to ${provider.model}`, reply })
  } catch (error) {
    res.json({ ok: false, message: (error as Error).message })
  }
})

/* ------------------------------------------------------------- workspace */

app.get('/api/workspace/:id/tree', async (req: Request, res: Response) => {
  const root = await ensureWorkspace(paramString(req, 'id'))
  const entries = await collectTree(root)
  res.json({ workspaceId: paramString(req, 'id'), entries })
})

app.get('/api/workspace/:id/file', async (req: Request, res: Response) => {
  const root = await ensureWorkspace(paramString(req, 'id'))
  const absolute = resolveInWorkspace(root, queryString(req, 'path'))
  const stat = await fs.stat(absolute).catch(() => null)
  if (!stat) throw new HttpError(404, 'File not found.')
  if (stat.isDirectory()) throw new HttpError(400, 'That path is a directory.')

  const limit = 400_000
  if (stat.size > limit) {
    const handle = await fs.open(absolute, 'r')
    const buffer = Buffer.alloc(limit)
    await handle.read(buffer, 0, limit, 0)
    await handle.close()
    res.json({
      path: queryString(req, 'path'),
      content: buffer.toString('utf8'),
      truncated: true,
      binary: false,
      size: stat.size,
    })
    return
  }

  const buffer = await fs.readFile(absolute)
  const binary = buffer.subarray(0, 4096).includes(0)
  res.json({
    path: queryString(req, 'path'),
    content: binary ? '' : buffer.toString('utf8'),
    truncated: false,
    binary,
    size: stat.size,
  })
})

app.get('/api/workspace/:id/download', async (req: Request, res: Response) => {
  const root = await ensureWorkspace(paramString(req, 'id'))
  const absolute = resolveInWorkspace(root, queryString(req, 'path'))
  const stat = await fs.stat(absolute).catch(() => null)
  if (!stat?.isFile()) throw new HttpError(404, 'File not found.')
  res.download(absolute, path.basename(absolute))
})

app.delete('/api/workspace/:id', async (req: Request, res: Response) => {
  const root = workspaceDir(paramString(req, 'id'))
  await fs.rm(root, { recursive: true, force: true })
  res.json({ ok: true })
})

function queryString(req: Request, key: string): string {
  const value = req.query[key]
  return typeof value === 'string' ? value : ''
}

function paramString(req: Request, key: string): string {
  const value = req.params[key]
  if (Array.isArray(value)) return value[0] ?? ''
  return typeof value === 'string' ? value : ''
}

async function ensureWorkspace(id: string): Promise<string> {
  const root = workspaceDir(id)
  await fs.mkdir(root, { recursive: true })
  return root
}

/* ------------------------------------------------------------------ meta */

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, mode: IS_PROD ? 'production' : 'development', cwd: PROJECT_ROOT })
})

app.use('/api', (_req, res) => {
  res.status(404).json({ error: 'Unknown API route.' })
})

/* ------------------------------------------------------- client + listen */

const server = http.createServer(app)

if (IS_PROD) {
  const dist = path.join(PROJECT_ROOT, 'dist')
  app.use(express.static(dist))
  app.use((_req, res) => res.sendFile(path.join(dist, 'index.html')))
} else {
  const { createServer } = await import('vite')
  const vite = await createServer({
    server: { middlewareMode: true, ws: { server } },
    appType: 'spa',
  })
  app.use(vite.middlewares)
}

app.use((error: Error, _req: Request, res: Response, _next: express.NextFunction) => {
  const status = error instanceof HttpError ? error.status : 500
  if (status >= 500) console.error('[server]', error)
  if (!res.headersSent) res.status(status).json({ error: error.message })
})

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  BYOK Agent · ${IS_PROD ? 'production' : 'development'}`)
  console.log(`  http://localhost:${PORT}\n`)
})
