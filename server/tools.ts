import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { resolveInWorkspace, toWorkspacePath } from './paths'

/* ------------------------------------------------------------------ types */

export type ToolDefinition = {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: {
      type: 'object'
      properties: Record<string, unknown>
      required?: string[]
      additionalProperties?: boolean
    }
  }
}

export type ToolResult = {
  ok: boolean
  output: string
  meta?: Record<string, unknown>
}

export type ToolContext = {
  root: string
  signal: AbortSignal
  /** Streamed command output, forwarded to the browser as it happens. */
  onOutput: (chunk: string, stream: 'stdout' | 'stderr') => void
}

/* ---------------------------------------------------------------- schemas */

export const toolDefinitions: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'list_files',
      description:
        'List files and directories in the workspace. Use it to discover the project layout before reading or writing files.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Directory path relative to the workspace root. Defaults to "." (the root).',
          },
          depth: {
            type: 'integer',
            description: 'How many directory levels to recurse, 1-4. Defaults to 3.',
          },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description:
        'Read a UTF-8 text file. Returns line-numbered content. Use start_line/end_line for large files.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path relative to the workspace root.' },
          start_line: { type: 'integer', description: 'First line to return (1-based, inclusive).' },
          end_line: { type: 'integer', description: 'Last line to return (1-based, inclusive).' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description:
        'Create or overwrite a file with exact content. Parent directories are created automatically. Always provide the complete file content.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path relative to the workspace root.' },
          content: { type: 'string', description: 'The full file content to write.' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'edit_file',
      description:
        'Replace an exact string inside an existing file. Prefer this over write_file for targeted changes. The find string must match exactly, including indentation.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path relative to the workspace root.' },
          find: { type: 'string', description: 'Exact text to replace.' },
          replace: { type: 'string', description: 'Replacement text.' },
          replace_all: {
            type: 'boolean',
            description: 'Replace every occurrence instead of requiring a unique match.',
          },
        },
        required: ['path', 'find', 'replace'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_command',
      description:
        'Run a bash command in the workspace root and return its exit code, stdout and stderr. Use it to install dependencies, run scripts, tests and builds.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'The bash command to run.' },
          timeout_ms: {
            type: 'integer',
            description: 'Kill the command after this many milliseconds (default 30000, max 180000).',
          },
        },
        required: ['command'],
      },
    },
  },
]

export const TOOL_NAMES = toolDefinitions.map((t) => t.function.name)

/* ------------------------------------------------------------- constants */

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.venv',
  'venv',
  '__pycache__',
  '.cache',
  '.turbo',
  '.pnpm-store',
])

const MAX_READ_BYTES = 400_000
const MAX_READ_LINES = 2000
const HARD_OUTPUT_CAP = 400_000
const OUTPUT_TAIL = 24_000
const MAX_ENTRIES = 600
const DEFAULT_TIMEOUT = 30_000
const MAX_TIMEOUT = 180_000

/** Catastrophic commands we refuse to hand to bash. This is a guard-rail, not a sandbox. */
const REFUSED_PATTERNS: Array<{ re: RegExp; why: string }> = [
  { re: /rm\s+(-[a-zA-Z]*\s+)+(--no-preserve-root\s+)?\/(\s|$|\*)/, why: 'deleting the filesystem root' },
  { re: /rm\s+-[a-zA-Z]*(rf|fr)[a-zA-Z]*\s+(~|\$HOME|\/root|\/home)\b/, why: 'deleting a home directory' },
  { re: /\bmkfs(\.\w+)?\b/, why: 'formatting a disk' },
  { re: /\bdd\b[^\n]*\bof=\/dev\/(sd|nvme|disk)/, why: 'writing raw disk images' },
  { re: /\b(shutdown|reboot|halt|poweroff|init\s+0)\b/, why: 'powering off the machine' },
  { re: /:\s*\(\s*\)\s*\{[^}]*\};\s*:/, why: 'a fork bomb' },
  { re: />\s*\/dev\/(sd|nvme)/, why: 'writing to a raw disk device' },
  { re: /\bchmod\s+-R\s+777\s+\/(\s|$)/, why: 'changing permissions on the filesystem root' },
]

/* --------------------------------------------------------------- helpers */

function cleanRelative(input: unknown, fallback = '.'): string {
  if (typeof input !== 'string') return fallback
  const trimmed = input.trim().replace(/^\.\/+/, '')
  return trimmed === '' ? fallback : trimmed
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function truncateMiddle(value: string, limit: number): string {
  if (value.length <= limit) return value
  const head = Math.floor(limit * 0.2)
  const tail = limit - head
  return `${value.slice(0, head)}\n… [${value.length - limit} characters elided] …\n${value.slice(-tail)}`
}

/* ----------------------------------------------------------- list / tree */

export type TreeEntry = { path: string; type: 'file' | 'dir'; size?: number }

export async function collectTree(root: string, maxEntries = 2000): Promise<TreeEntry[]> {
  const entries: TreeEntry[] = []
  async function walk(dir: string, rel: string) {
    if (entries.length >= maxEntries) return
    let dirents
    try {
      dirents = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    dirents.sort((a, b) => {
      const aDir = a.isDirectory() ? 0 : 1
      const bDir = b.isDirectory() ? 0 : 1
      if (aDir !== bDir) return aDir - bDir
      return a.name.localeCompare(b.name)
    })
    for (const d of dirents) {
      if (entries.length >= maxEntries) return
      if (d.name === '.git') continue
      const childRel = rel ? `${rel}/${d.name}` : d.name
      if (d.isDirectory()) {
        if (SKIP_DIRS.has(d.name)) continue
        entries.push({ path: childRel, type: 'dir' })
        await walk(path.join(dir, d.name), childRel)
      } else if (d.isFile()) {
        let size: number | undefined
        try {
          size = (await fs.stat(path.join(dir, d.name))).size
        } catch {
          size = undefined
        }
        entries.push({ path: childRel, type: 'file', size })
      }
    }
  }
  await walk(root, '')
  return entries
}

async function listFiles(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult> {
  const rel = cleanRelative(args.path)
  const depth = Math.min(4, Math.max(1, Number(args.depth) || 3))
  const target = resolveInWorkspace(ctx.root, rel)
  const rootStat = await fs.stat(target).catch(() => null)
  if (!rootStat) return { ok: false, output: `Path "${rel}" does not exist.` }
  if (!rootStat.isDirectory()) return { ok: false, output: `"${rel}" is a file. Use read_file instead.` }

  const lines: string[] = []
  let count = 0
  let truncated = false

  async function walk(dir: string, prefix: string, level: number) {
    if (count >= MAX_ENTRIES) {
      truncated = true
      return
    }
    let dirents
    try {
      dirents = await fs.readdir(dir, { withFileTypes: true })
    } catch (error) {
      lines.push(`${prefix}[unreadable: ${(error as Error).message}]`)
      return
    }
    dirents.sort((a, b) => {
      const aDir = a.isDirectory() ? 0 : 1
      const bDir = b.isDirectory() ? 0 : 1
      if (aDir !== bDir) return aDir - bDir
      return a.name.localeCompare(b.name)
    })
    for (const ent of dirents) {
      if (count >= MAX_ENTRIES) {
        truncated = true
        return
      }
      if (SKIP_DIRS.has(ent.name)) {
        lines.push(`${prefix}${ent.name}/  (skipped: generated/dependency directory)`)
        continue
      }
      if (ent.isDirectory()) {
        lines.push(`${prefix}${ent.name}/`)
        count++
        if (level < depth) await walk(path.join(dir, ent.name), `${prefix}  `, level + 1)
      } else if (ent.isFile()) {
        let size = 0
        try {
          size = (await fs.stat(path.join(dir, ent.name))).size
        } catch {
          size = 0
        }
        lines.push(`${prefix}${ent.name}  (${formatBytes(size)})`)
        count++
      }
    }
  }

  await walk(target, '', 1)
  const header = `Contents of ${rel === '.' ? 'workspace root' : rel} (${count} entries):`
  const body = lines.length > 0 ? lines.join('\n') : '(empty directory)'
  return {
    ok: true,
    output: `${header}\n${body}${truncated ? `\n… (listing truncated at ${MAX_ENTRIES} entries)` : ''}`,
    meta: { entries: count, path: rel },
  }
}

/* ---------------------------------------------------------------- read */

async function readFile(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult> {
  const rel = cleanRelative(args.path)
  const target = resolveInWorkspace(ctx.root, rel)
  const stat = await fs.stat(target).catch(() => null)
  if (!stat) return { ok: false, output: `File "${rel}" does not exist. Run list_files to see what is there.` }
  if (stat.isDirectory()) return { ok: false, output: `"${rel}" is a directory. Use list_files instead.` }
  if (stat.size > MAX_READ_BYTES) {
    return {
      ok: false,
      output: `"${rel}" is ${formatBytes(stat.size)}, too large to read at once. Use run_command with head/sed to inspect parts.`,
    }
  }

  const raw = await fs.readFile(target, 'utf8')
  if (raw.includes('\u0000')) {
    return { ok: false, output: `"${rel}" looks like a binary file (${formatBytes(stat.size)}).` }
  }

  const allLines = raw.split('\n')
  const start = Math.max(1, Number(args.start_line) || 1)
  const requestedEnd = Number(args.end_line) || allLines.length
  const end = Math.min(allLines.length, Math.max(start, requestedEnd))
  let slice = allLines.slice(start - 1, end)
  let clipped = false
  if (slice.length > MAX_READ_LINES) {
    slice = slice.slice(0, MAX_READ_LINES)
    clipped = true
  }
  const width = String(end).length
  const numbered = slice
    .map((line, i) => `${String(start + i).padStart(width, ' ')}  ${line}`)
    .join('\n')
  const tail = clipped
    ? `\n… (stopped at ${MAX_READ_LINES} lines, file has ${allLines.length}; read further with start_line)`
    : ''

  return {
    ok: true,
    output: `${rel} (lines ${start}-${start + slice.length - 1} of ${allLines.length}):\n${numbered}${tail}`,
    meta: { path: rel, lines: allLines.length, bytes: stat.size },
  }
}

/* --------------------------------------------------------------- write */

async function writeFile(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult> {
  const rel = cleanRelative(args.path, '')
  if (!rel) return { ok: false, output: 'path is required.' }
  if (typeof args.content !== 'string') {
    return { ok: false, output: 'content must be a string containing the full file content.' }
  }
  const target = resolveInWorkspace(ctx.root, rel)
  await fs.mkdir(path.dirname(target), { recursive: true })
  const existing = await fs.stat(target).catch(() => null)
  if (existing?.isDirectory()) return { ok: false, output: `"${rel}" is a directory, not a file.` }
  await fs.writeFile(target, args.content, 'utf8')
  const lines = args.content === '' ? 0 : args.content.split('\n').length
  const action = existing ? 'Updated' : 'Created'
  return {
    ok: true,
    output: `${action} ${rel} (${formatBytes(Buffer.byteLength(args.content))}, ${lines} lines).`,
    meta: { path: rel, lines, created: !existing, bytes: Buffer.byteLength(args.content) },
  }
}

/* ---------------------------------------------------------------- edit */

async function editFile(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult> {
  const rel = cleanRelative(args.path, '')
  const find = typeof args.find === 'string' ? args.find : ''
  const replace = typeof args.replace === 'string' ? args.replace : ''
  if (!rel) return { ok: false, output: 'path is required.' }
  if (!find) return { ok: false, output: 'find must be a non-empty string.' }
  if (find === replace) return { ok: false, output: 'find and replace are identical, nothing to do.' }

  const target = resolveInWorkspace(ctx.root, rel)
  const original = await fs.readFile(target, 'utf8').catch(() => null)
  if (original === null) return { ok: false, output: `File "${rel}" does not exist. Use write_file to create it.` }

  const first = original.indexOf(find)
  if (first === -1) {
    return {
      ok: false,
      output: `No exact match for the find string in ${rel}. Re-read the file and copy the text verbatim, including whitespace.`,
    }
  }

  const occurrences = original.split(find).length - 1
  if (occurrences > 1 && args.replace_all !== true) {
    return {
      ok: false,
      output: `The find string appears ${occurrences} times in ${rel}. Include more surrounding context to make it unique, or pass replace_all: true.`,
    }
  }

  const updated =
    args.replace_all === true ? original.split(find).join(replace) : original.replace(find, replace)
  await fs.writeFile(target, updated, 'utf8')

  const before = original.split('\n').length
  const after = updated.split('\n').length
  const added = Math.max(0, after - before)
  const removed = Math.max(0, before - after)
  return {
    ok: true,
    output: `Edited ${rel}: ${occurrences > 1 ? `${occurrences} replacements` : '1 replacement'}, ${added} line(s) added, ${removed} removed (now ${after} lines).`,
    meta: { path: rel, added, removed, lines: after, replacements: occurrences },
  }
}

/* ------------------------------------------------------------ run shell */

async function runCommand(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult> {
  const command = typeof args.command === 'string' ? args.command.trim() : ''
  if (!command) return { ok: false, output: 'command is required.' }

  const refusal = REFUSED_PATTERNS.find((p) => p.re.test(command))
  if (refusal) {
    return {
      ok: false,
      output: `Refused: this command looks like ${refusal.why}, which is blocked by the app's safety guard. Try a narrower command.`,
      meta: { refused: true },
    }
  }

  const timeout = Math.min(MAX_TIMEOUT, Math.max(1_000, Number(args.timeout_ms) || DEFAULT_TIMEOUT))
  await fs.mkdir(path.join(ctx.root, '.tmp'), { recursive: true }).catch(() => {})

  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin',
    HOME: ctx.root,
    TMPDIR: path.join(ctx.root, '.tmp'),
    TEMP: path.join(ctx.root, '.tmp'),
    PWD: ctx.root,
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    TERM: 'dumb',
    CI: '1',
    BYOK_AGENT: '1',
    NO_COLOR: '1',
    npm_config_update_notifier: 'false',
    npm_config_fund: 'false',
    npm_config_audit: 'false',
    PYTHONUNBUFFERED: '1',
    PYTHONDONTWRITEBYTECODE: '1',
  }

  const startedAt = Date.now()
  return await new Promise<ToolResult>((resolve) => {
    let settled = false
    let stdout = ''
    let stderr = ''
    let truncated = false
    let timedOut = false

    const child = spawn('/bin/bash', ['-lc', command], {
      cwd: ctx.root,
      env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    const killTree = (signal: NodeJS.Signals) => {
      if (!child.pid) return
      try {
        process.kill(-child.pid, signal)
      } catch {
        try {
          child.kill(signal)
        } catch {
          /* already gone */
        }
      }
    }

    const timer = setTimeout(() => {
      timedOut = true
      killTree('SIGKILL')
    }, timeout)

    const onAbort = () => killTree('SIGKILL')
    ctx.signal.addEventListener('abort', onAbort, { once: true })

    const collect = (stream: 'stdout' | 'stderr') => (chunk: Buffer | string) => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8')
      if (stdout.length + stderr.length > HARD_OUTPUT_CAP) {
        truncated = true
        return
      }
      if (stream === 'stdout') stdout += text
      else stderr += text
      ctx.onOutput(text, stream)
    }

    child.stdout?.on('data', collect('stdout'))
    child.stderr?.on('data', collect('stderr'))

    const finish = (exitCode: number | null, signal: string | null, spawnError?: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      ctx.signal.removeEventListener('abort', onAbort)

      if (spawnError) {
        resolve({ ok: false, output: `Failed to start command: ${spawnError.message}` })
        return
      }

      const durationMs = Date.now() - startedAt
      const ok = exitCode === 0 && !timedOut
      const sections: string[] = []
      if (timedOut) {
        sections.push(`Timed out after ${timeout} ms and the process tree was killed.`)
      }
      if (signal && !timedOut) sections.push(`Terminated by signal ${signal}.`)
      sections.push(`exit code: ${exitCode ?? 'unknown'}  ·  ${durationMs} ms`)
      if (stdout.trim()) sections.push(`--- stdout ---\n${truncateMiddle(stdout, OUTPUT_TAIL)}`)
      if (stderr.trim()) sections.push(`--- stderr ---\n${truncateMiddle(stderr, OUTPUT_TAIL)}`)
      if (!stdout.trim() && !stderr.trim()) sections.push('(no output)')
      if (truncated) sections.push(`… output exceeded ${HARD_OUTPUT_CAP} bytes and was cut off.`)

      resolve({
        ok,
        output: sections.join('\n'),
        meta: { exitCode, durationMs, timedOut, command },
      })
    }

    child.on('error', (error) => finish(null, null, error))
    child.on('close', (code, signal) => finish(code, signal))
  })
}

/* --------------------------------------------------------------- router */

export async function executeTool(
  name: string,
  rawArgs: unknown,
  ctx: ToolContext,
): Promise<ToolResult> {
  let args: Record<string, unknown> = {}
  if (typeof rawArgs === 'string' && rawArgs.trim() !== '') {
    try {
      args = JSON.parse(rawArgs) as Record<string, unknown>
    } catch {
      return { ok: false, output: `Tool arguments were not valid JSON: ${rawArgs.slice(0, 300)}` }
    }
  } else if (rawArgs && typeof rawArgs === 'object') {
    args = rawArgs as Record<string, unknown>
  }

  try {
    switch (name) {
      case 'list_files':
        return await listFiles(ctx, args)
      case 'read_file':
        return await readFile(ctx, args)
      case 'write_file':
        return await writeFile(ctx, args)
      case 'edit_file':
        return await editFile(ctx, args)
      case 'run_command':
        return await runCommand(ctx, args)
      default:
        return {
          ok: false,
          output: `Unknown tool "${name}". Available tools: ${TOOL_NAMES.join(', ')}.`,
        }
    }
  } catch (error) {
    return { ok: false, output: `Tool "${name}" failed: ${(error as Error).message}` }
  }
}

export { toWorkspacePath, formatBytes }
