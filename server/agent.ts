import { executeTool, toolDefinitions } from './tools'

/* --------------------------------------------------------------- protocol */

export type ToolCall = {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

export type WireMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | null
  tool_calls?: ToolCall[]
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
  | { type: 'notice'; text: string }
  | { type: 'done'; steps: number; elapsedMs: number }
  | { type: 'error'; message: string }

export type ProviderConfig = {
  apiKey: string
  baseUrl: string
  model: string
  maxSteps?: number
}

/* ---------------------------------------------------------------- helpers */

const PROVIDER_TOOL_OUTPUT_LIMIT = 14_000

function completionsUrl(baseUrl: string): string {
  const trimmed = (baseUrl || '').trim().replace(/\/+$/, '')
  if (!/^https?:\/\//i.test(trimmed)) {
    throw new Error('Base URL must start with http:// or https://')
  }
  if (/\/chat\/completions$/i.test(trimmed)) return trimmed
  return `${trimmed}/chat/completions`
}

function parseArgs(raw: string | undefined): unknown {
  if (!raw || !raw.trim()) return {}
  try {
    return JSON.parse(raw)
  } catch {
    return { _raw: raw }
  }
}

function capForProvider(text: string, limit = PROVIDER_TOOL_OUTPUT_LIMIT): string {
  if (text.length <= limit) return text
  const head = text.slice(0, limit * 0.7)
  const tail = text.slice(-limit * 0.2)
  return `${head}\n… [${text.length - limit} characters of output elided] …\n${tail}`
}

class ProviderError extends Error {
  status: number
  retryable: boolean
  constructor(message: string, status = 0, retryable = false) {
    super(message)
    this.status = status
    this.retryable = retryable
  }
}

function explainHttpError(status: number, body: string): string {
  const snippet = body.replace(/\s+/g, ' ').slice(0, 400)
  const hint = (() => {
    if (status === 401 || status === 403) return 'The provider rejected the credentials. Check the API key in Settings.'
    if (status === 404) return 'Endpoint not found. Most base URLs end in /v1 — check it in Settings.'
    if (status === 402) return 'The provider reports no remaining credit for this key.'
    if (status === 429) return 'Rate limited or out of quota for now.'
    if (status >= 500) return 'The provider had a server error.'
    if (status === 400) return 'The provider rejected the request — the model name may be wrong, or it may not support tool calling.'
    return ''
  })()
  return `Provider error ${status}. ${hint}${snippet ? `\n\n${snippet}` : ''}`
}

/* ------------------------------------------------------- provider streaming */

type StreamOutcome = { text: string; toolCalls: ToolCall[] }

type DeltaToolCall = {
  index?: number
  id?: string
  type?: string
  function?: { name?: string; arguments?: string }
}

async function streamCompletion(options: {
  provider: ProviderConfig
  messages: WireMessage[]
  signal: AbortSignal
  onText: (text: string) => void
}): Promise<StreamOutcome> {
  const { provider, messages, signal, onText } = options
  const url = completionsUrl(provider.baseUrl)
  if (!provider.model?.trim()) throw new ProviderError('No model configured. Add one in Settings.')

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'text/event-stream',
  }
  if (provider.apiKey?.trim()) headers.Authorization = `Bearer ${provider.apiKey.trim()}`

  let response: Response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers,
      signal,
      body: JSON.stringify({
        model: provider.model.trim(),
        messages,
        tools: toolDefinitions,
        tool_choice: 'auto',
        stream: true,
      }),
    })
  } catch (error) {
    if (signal.aborted) throw error
    const message = error instanceof Error ? error.message : String(error)
    throw new ProviderError(
      `Could not reach ${url}. ${message}\n\nCheck the base URL, your network, and that the provider is up.`,
      0,
      true,
    )
  }

  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new ProviderError(
      explainHttpError(response.status, body),
      response.status,
      response.status === 429 || response.status >= 500,
    )
  }

  const contentType = response.headers.get('content-type') ?? ''

  // Some gateways ignore stream: true and answer with one JSON document.
  if (contentType.includes('application/json')) {
    const payload = (await response.json()) as any
    if (payload?.error) {
      throw new ProviderError(payload.error.message ?? JSON.stringify(payload.error))
    }
    const message = payload?.choices?.[0]?.message ?? {}
    const text = typeof message.content === 'string' ? message.content : ''
    if (text) onText(text)
    const toolCalls: ToolCall[] = Array.isArray(message.tool_calls)
      ? message.tool_calls.map((call: any, index: number) => ({
          id: call.id ?? `call_${index}`,
          type: 'function',
          function: {
            name: call.function?.name ?? '',
            arguments:
              typeof call.function?.arguments === 'string'
                ? call.function.arguments
                : JSON.stringify(call.function?.arguments ?? {}),
          },
        }))
      : []
    return { text, toolCalls }
  }

  if (!response.body) throw new ProviderError('The provider returned an empty response body.')

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let text = ''
  let finished = false
  const toolAcc = new Map<number, { id: string; name: string; args: string }>()

  const consume = (payload: string) => {
    const trimmed = payload.trim()
    if (!trimmed || trimmed === '[DONE]') {
      if (trimmed === '[DONE]') finished = true
      return
    }
    let json: any
    try {
      json = JSON.parse(trimmed)
    } catch {
      return
    }
    if (json?.error) {
      throw new ProviderError(json.error.message ?? JSON.stringify(json.error))
    }
    const choice = json?.choices?.[0]
    const delta = choice?.delta ?? choice?.message
    if (!delta) return

    const content = delta.content
    if (typeof content === 'string' && content.length > 0) {
      text += content
      onText(content)
    } else if (Array.isArray(content)) {
      // Some providers send content part arrays even while streaming.
      for (const part of content) {
        if (part?.type === 'text' && typeof part.text === 'string') {
          text += part.text
          onText(part.text)
        }
      }
    }

    if (Array.isArray(delta.tool_calls)) {
      for (const raw of delta.tool_calls as DeltaToolCall[]) {
        const index = typeof raw.index === 'number' ? raw.index : toolAcc.size
        const existing = toolAcc.get(index) ?? { id: '', name: '', args: '' }
        if (raw.id) existing.id = raw.id
        if (raw.function?.name) existing.name = raw.function.name
        if (typeof raw.function?.arguments === 'string') existing.args += raw.function.arguments
        else if (raw.function?.arguments && typeof raw.function.arguments === 'object') {
          existing.args += JSON.stringify(raw.function.arguments)
        }
        toolAcc.set(index, existing)
      }
    }
  }

  while (!finished) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })

    let boundary = /\r?\n\r?\n/.exec(buffer)
    while (boundary) {
      const block = buffer.slice(0, boundary.index)
      buffer = buffer.slice(boundary.index + boundary[0].length)
      const data = block
        .split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart())
        .join('\n')
      if (data) consume(data)
      if (finished) break
      boundary = /\r?\n\r?\n/.exec(buffer)
    }
  }

  try {
    await reader.cancel()
  } catch {
    /* stream already closed */
  }

  const toolCalls: ToolCall[] = [...toolAcc.entries()]
    .sort((a, b) => a[0] - b[0])
    .filter(([, value]) => value.name)
    .map(([index, value]) => ({
      id: value.id || `call_${index}_${Math.random().toString(36).slice(2, 8)}`,
      type: 'function',
      function: { name: value.name, arguments: value.args },
    }))

  return { text, toolCalls }
}

/* ------------------------------------------------------------- agent loop */

export async function runAgent(options: {
  provider: ProviderConfig
  messages: WireMessage[]
  workspaceRoot: string
  signal: AbortSignal
  emit: (event: AgentEvent) => void
}): Promise<void> {
  const { provider, workspaceRoot, signal, emit } = options
  const messages: WireMessage[] = [...options.messages]
  const maxSteps = Math.min(40, Math.max(1, Number(provider.maxSteps) || 16))
  const startedAt = Date.now()
  let steps = 0

  for (steps = 0; steps < maxSteps; steps++) {
    let emitted = false
    let outcome: StreamOutcome
    try {
      outcome = await streamCompletion({
        provider,
        messages,
        signal,
        onText: (chunk) => {
          emitted = true
          emit({ type: 'text', text: chunk })
        },
      })
    } catch (error) {
      if (signal.aborted) {
        emit({ type: 'notice', text: 'Stopped.' })
        emit({ type: 'done', steps, elapsedMs: Date.now() - startedAt })
        return
      }
      const err = error as ProviderError
      // One quick retry for rate limits / transient network trouble.
      if ((err.retryable || err.status === 0) && !emitted) {
        await new Promise((resolve) => setTimeout(resolve, 900))
        try {
          outcome = await streamCompletion({
            provider,
            messages,
            signal,
            onText: (chunk) => emit({ type: 'text', text: chunk }),
          })
        } catch (retryError) {
          emit({ type: 'error', message: (retryError as Error).message })
          return
        }
      } else {
        emit({ type: 'error', message: err.message ?? String(error) })
        return
      }
    }

    if (outcome.toolCalls.length === 0) {
      if (!outcome.text.trim()) {
        emit({
          type: 'notice',
          text: 'The model returned an empty message. Check the model name and that the provider supports tool calling.',
        })
      }
      emit({ type: 'done', steps: steps + 1, elapsedMs: Date.now() - startedAt })
      return
    }

    messages.push({
      role: 'assistant',
      content: outcome.text || '',
      tool_calls: outcome.toolCalls,
    })

    for (const call of outcome.toolCalls) {
      if (signal.aborted) {
        emit({ type: 'notice', text: 'Stopped.' })
        emit({ type: 'done', steps: steps + 1, elapsedMs: Date.now() - startedAt })
        return
      }
      const toolArgs = parseArgs(call.function.arguments)
      emit({
        type: 'tool_start',
        id: call.id,
        name: call.function.name,
        args: toolArgs,
        step: steps + 1,
      })

      const toolStartedAt = Date.now()
      const result = await executeTool(call.function.name, toolArgs, {
        root: workspaceRoot,
        signal,
        onOutput: (chunk, stream) => emit({ type: 'tool_progress', id: call.id, chunk, stream }),
      })

      emit({
        type: 'tool_end',
        id: call.id,
        ok: result.ok,
        output: result.output,
        meta: result.meta,
        durationMs: Date.now() - toolStartedAt,
      })

      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        content: capForProvider(result.output),
      })
    }
  }

  emit({
    type: 'notice',
    text: `Reached the ${maxSteps}-step limit for this turn. Send "continue" to keep going.`,
  })
  emit({ type: 'done', steps, elapsedMs: Date.now() - startedAt })
}
