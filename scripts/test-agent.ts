/**
 * End-to-end checks for the agent: tool behaviour, the streaming tool loop
 * against a mock OpenAI-compatible provider, and the workspace HTTP API.
 *
 *   npx tsx scripts/test-agent.ts
 */
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { executeTool } from '../server/tools'
import { PROJECT_ROOT } from '../server/paths'

let failures = 0
let checks = 0

function check(name: string, condition: boolean, detail?: string) {
  checks++
  if (condition) {
    console.log(`  ✓ ${name}`)
  } else {
    failures++
    console.error(`  ✗ ${name}${detail ? `\n      ${detail.replace(/\n/g, '\n      ')}` : ''}`)
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitFor(url: string, timeoutMs = 30_000): Promise<boolean> {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(url)
      if (response.ok) return true
    } catch {
      /* not up yet */
    }
    await sleep(200)
  }
  return false
}

function spawnLogged(command: string, args: string[], env: NodeJS.ProcessEnv): ChildProcess {
  const child = spawn(command, args, { cwd: PROJECT_ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] })
  const logs: string[] = []
  child.stdout?.on('data', (d) => logs.push(d.toString()))
  child.stderr?.on('data', (d) => logs.push(d.toString()))
  ;(child as ChildProcess & { logs: string[] }).logs = logs
  return child
}

async function stop(child: ChildProcess) {
  if (child.exitCode !== null) return
  child.kill('SIGTERM')
  await sleep(400)
  if (child.exitCode === null) child.kill('SIGKILL')
}

/* --------------------------------------------------------- tool unit tests */

async function testTools() {
  console.log('\nTools')
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'byok-tools-'))
  const controller = new AbortController()
  const ctx = {
    root,
    signal: controller.signal,
    onOutput: () => {
      /* streamed output is not asserted here */
    },
  }

  const write = await executeTool(
    'write_file',
    { path: 'src/deep/app.js', content: "console.log('hi')\n" },
    ctx,
  )
  check('write_file creates nested files', write.ok && write.output.includes('src/deep/app.js'), write.output)
  const written = await fs.readFile(path.join(root, 'src/deep/app.js'), 'utf8')
  check('write_file content matches exactly', written === "console.log('hi')\n", JSON.stringify(written))

  const read = await executeTool('read_file', { path: 'src/deep/app.js' }, ctx)
  check(
    'read_file returns line-numbered content',
    read.ok && read.output.includes("1  console.log('hi')"),
    read.output,
  )

  const edit = await executeTool(
    'edit_file',
    { path: 'src/deep/app.js', find: "'hi'", replace: "'edited'" },
    ctx,
  )
  check('edit_file applies a unique replacement', edit.ok, edit.output)
  check(
    'edit_file persists the change',
    (await fs.readFile(path.join(root, 'src/deep/app.js'), 'utf8')) === "console.log('edited')\n",
  )

  await executeTool('write_file', { path: 'dup.txt', content: 'alpha beta alpha\n' }, ctx)
  const ambiguous = await executeTool(
    'edit_file',
    { path: 'dup.txt', find: 'alpha', replace: 'gamma' },
    ctx,
  )
  check('edit_file rejects a non-unique find without replace_all', !ambiguous.ok, ambiguous.output)

  const replaceAll = await executeTool(
    'edit_file',
    { path: 'dup.txt', find: 'alpha', replace: 'gamma', replace_all: true },
    ctx,
  )
  check(
    'edit_file replace_all rewrites every occurrence',
    replaceAll.ok && (await fs.readFile(path.join(root, 'dup.txt'), 'utf8')) === 'gamma beta gamma\n',
    replaceAll.output,
  )

  const listing = await executeTool('list_files', { path: '.', depth: 3 }, ctx)
  check('list_files lists the tree', listing.ok && listing.output.includes('app.js'), listing.output)

  const ok = await executeTool('run_command', { command: 'echo hello-there' }, ctx)
  check(
    'run_command reports stdout and exit code 0',
    ok.ok && ok.output.includes('hello-there') && ok.output.includes('exit code: 0'),
    ok.output,
  )

  const failing = await executeTool('run_command', { command: 'echo boom >&2; exit 7' }, ctx)
  check('run_command surfaces non-zero exit codes', !failing.ok && failing.output.includes('exit code: 7'), failing.output)

  const refused = await executeTool('run_command', { command: 'rm -rf /' }, ctx)
  check('run_command refuses catastrophic commands', !refused.ok && refused.output.includes('Refused'), refused.output)

  const escape = await executeTool('read_file', { path: '../../etc/passwd' }, ctx)
  check('path traversal is blocked', !escape.ok && escape.output.includes('escapes the workspace'), escape.output)

  const absolute = await executeTool('read_file', { path: '/etc/passwd' }, ctx)
  check('absolute paths are rejected', !absolute.ok && absolute.output.includes('Absolute paths'), absolute.output)

  const slow = await executeTool('run_command', { command: 'sleep 5', timeout_ms: 1000 }, ctx)
  check('run_command enforces its timeout', !slow.ok && slow.output.includes('Timed out'), slow.output)

  await fs.rm(root, { recursive: true, force: true })
}

/* ------------------------------------------------------------ http e2e */

type SseEvent = { type: string; [key: string]: unknown }

async function readSse(response: Response, onEvent: (event: SseEvent) => void): Promise<void> {
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
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
      if (payload) onEvent(JSON.parse(payload) as SseEvent)
      boundary = buffer.indexOf('\n\n')
    }
  }
}

async function testHttp() {
  console.log('\nServer + agent loop')
  const appPort = 3210
  const mockPort = 4010
  const provider = { apiKey: 'test-key', baseUrl: `http://127.0.0.1:${mockPort}/v1`, model: 'mock-agent', maxSteps: 8 }

  const mock = spawnLogged(process.execPath, ['scripts/mock-provider.mjs', String(mockPort)], process.env)
  const mockUp = await waitFor(`http://127.0.0.1:${mockPort}/health`, 10_000)
  check('mock provider is up', mockUp)
  if (!mockUp) {
    console.error(String((mock as any).logs?.join('')))
    return
  }

  const app = spawnLogged(
    path.join(PROJECT_ROOT, 'node_modules', '.bin', 'tsx'),
    ['server/index.ts'],
    { ...process.env, PORT: String(appPort) },
  )

  try {
    const up = await waitFor(`http://127.0.0.1:${appPort}/api/health`, 40_000)
    check('app server is up', up)
    if (!up) {
      console.error(String((app as any).logs?.join('')))
      return
    }

    const health = await (await fetch(`http://127.0.0.1:${appPort}/api/health`)).json()
    check('health endpoint responds', health.ok === true, JSON.stringify(health))

    // Non-streaming connection test used by the Settings dialog.
    const testResponse = await fetch(`http://127.0.0.1:${appPort}/api/test`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider }),
    })
    const testResult = (await testResponse.json()) as { ok: boolean; message: string }
    check('provider test succeeds', testResult.ok === true, JSON.stringify(testResult))

    // Invalid provider config is rejected before any streaming starts.
    const badResponse = await fetch(`http://127.0.0.1:${appPort}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        workspaceId: 'test-invalid',
        provider: { ...provider, baseUrl: 'nope' },
        messages: [{ role: 'user', content: 'hi' }],
      }),
    })
    check('invalid base URL is a 400', badResponse.status === 400, `status ${badResponse.status}`)

    const workspaceId = 'test-e2e'
    await fs.rm(path.join(PROJECT_ROOT, 'workspaces', workspaceId), { recursive: true, force: true })

    const chatResponse = await fetch(`http://127.0.0.1:${appPort}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        workspaceId,
        provider,
        messages: [{ role: 'user', content: 'Create hello.js and run it.' }],
      }),
    })

    check('chat responds with an event stream', chatResponse.headers.get('content-type')?.includes('text/event-stream') ?? false)

    const events: SseEvent[] = []
    await readSse(chatResponse, (event) => events.push(event))

    const text = events.filter((e) => e.type === 'text').map((e) => e.text).join('')
    const toolStarts = events.filter((e) => e.type === 'tool_start')
    const toolEnds = events.filter((e) => e.type === 'tool_end')
    const done = events.find((e) => e.type === 'done')
    const errors = events.filter((e) => e.type === 'error')

    check('no error events', errors.length === 0, JSON.stringify(errors))
    check(
      'agent called write_file then run_command',
      toolStarts.map((e) => e.name).join(',') === 'write_file,run_command',
      JSON.stringify(toolStarts.map((e) => e.name)),
    )
    check('each tool reported success', toolEnds.length === 2 && toolEnds.every((e) => e.ok === true), JSON.stringify(toolEnds.map((e) => e.ok)))
    check('streamed text reached the client', text.includes('hello from mock agent'), text)
    check('turn finished with a done event', Boolean(done), JSON.stringify(events.slice(-3)))

    const toolOutput = String(toolEnds[1]?.output ?? '')
    check('command output included the script result', toolOutput.includes('hello from mock agent'), toolOutput)

    const filePath = path.join(PROJECT_ROOT, 'workspaces', workspaceId, 'hello.js')
    const exists = await fs
      .readFile(filePath, 'utf8')
      .then((content) => content.includes('hello from mock agent'))
      .catch(() => false)
    check('agent file was written to the workspace', exists, filePath)

    const tree = (await (await fetch(`http://127.0.0.1:${appPort}/api/workspace/${workspaceId}/tree`)).json()) as {
      entries: Array<{ path: string }>
    }
    check('workspace tree lists the new file', tree.entries.some((entry) => entry.path === 'hello.js'), JSON.stringify(tree.entries))

    const filePayload = (await (
      await fetch(`http://127.0.0.1:${appPort}/api/workspace/${workspaceId}/file?path=hello.js`)
    ).json()) as { content: string }
    check('file preview returns the content', filePayload.content.includes('hello from mock agent'), filePayload.content)

    const traversal = await fetch(
      `http://127.0.0.1:${appPort}/api/workspace/${workspaceId}/file?path=${encodeURIComponent('../../package.json')}`,
    )
    check('file API rejects traversal', traversal.status === 400, `status ${traversal.status}`)

    const download = await fetch(
      `http://127.0.0.1:${appPort}/api/workspace/${workspaceId}/download?path=hello.js`,
    )
    check('download endpoint serves the file', download.status === 200, `status ${download.status}`)

    await fs.rm(path.join(PROJECT_ROOT, 'workspaces', workspaceId), { recursive: true, force: true })
  } finally {
    await stop(app)
    await stop(mock)
  }
}

console.log('BYOK Agent — end-to-end checks')
await testTools()
await testHttp()

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures > 0) {
  console.error(`${failures} check(s) failed`)
  process.exit(1)
}
process.exit(0)
