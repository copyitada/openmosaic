#!/usr/bin/env node
/**
 * A tiny OpenAI-compatible provider used for tests and offline demos.
 *
 *   node scripts/mock-provider.mjs 4010
 *
 * Point the app at http://127.0.0.1:4010/v1 with any API key and model "mock-agent".
 * The conversation it plays out:
 *   1. write_file  ./hello.js
 *   2. run_command node hello.js
 *   3. a short summary message
 */
import { createServer } from 'node:http'

const PORT = Number(process.argv[2] ?? 4010)

function sse(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`)
}

function textChunk(text) {
  return { choices: [{ index: 0, delta: { content: text } }] }
}

function toolChunk(index, id, name, argsFragment) {
  return {
    choices: [
      {
        index: 0,
        delta: {
          tool_calls: [
            {
              index,
              ...(id ? { id, type: 'function' } : {}),
              function: { ...(name ? { name } : {}), arguments: argsFragment },
            },
          ],
        },
      },
    ],
  }
}

async function streamText(res, text) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  })
  for (const word of text.split(' ')) {
    sse(res, textChunk(`${word} `))
    await new Promise((resolve) => setTimeout(resolve, 8))
  }
  sse(res, { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })
  res.write('data: [DONE]\n\n')
  res.end()
}

async function streamToolCalls(res, calls) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  })
  for (const [index, call] of calls.entries()) {
    sse(res, toolChunk(index, call.id, call.name, ''))
    const json = JSON.stringify(call.args)
    const slice = Math.ceil(json.length / 3)
    for (let offset = 0; offset < json.length; offset += slice) {
      sse(res, toolChunk(index, undefined, undefined, json.slice(offset, offset + slice)))
      await new Promise((resolve) => setTimeout(resolve, 6))
    }
  }
  sse(res, { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })
  res.write('data: [DONE]\n\n')
  res.end()
}

const server = createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: true }))
    return
  }

  if (req.method !== 'POST' || !req.url?.endsWith('/chat/completions')) {
    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: { message: 'Not found' } }))
    return
  }

  let body = ''
  for await (const chunk of req) body += chunk
  const payload = JSON.parse(body || '{}')

  if (payload.stream !== true) {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(
      JSON.stringify({
        choices: [{ message: { role: 'assistant', content: 'ready' }, finish_reason: 'stop' }],
      }),
    )
    return
  }

  const messages = Array.isArray(payload.messages) ? payload.messages : []
  const steps = messages.filter((m) => m.role === 'assistant' && m.tool_calls?.length).length

  if (steps === 0) {
    await streamToolCalls(res, [
      {
        id: 'call_write_1',
        name: 'write_file',
        args: { path: 'hello.js', content: "console.log('hello from mock agent')\n" },
      },
    ])
    return
  }

  if (steps === 1) {
    await streamToolCalls(res, [
      { id: 'call_run_1', name: 'run_command', args: { command: 'node hello.js' } },
    ])
    return
  }

  await streamText(res, 'Created hello.js and ran it — the script printed “hello from mock agent”.')
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`mock provider listening on http://127.0.0.1:${PORT}/v1`)
})
