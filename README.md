# BYOK Agent

A bring-your-own-key AI coding agent with a real workspace. It writes files, runs
shell commands, reads the output, and keeps going until the job actually works —
wrapped in a ChatGPT-style interface with streaming replies and live tool output.

## Quick start

```bash
npm install
npm run dev        # http://localhost:3000
```

1. Open **Settings** (the model name in the header or composer, or the sliders icon).
2. Pick a provider preset — or paste any OpenAI-compatible base URL.
3. Paste your API key, choose a model, hit **Test connection**, then **Save**.
4. Ask for something real: *"Build a snake game in ./games and run a sanity check."*

The key is stored only in **this browser's** `localStorage`. The server is
stateless with respect to credentials: it reads the key from the request, uses it
for that one streaming call, and never writes it to disk or logs.

### Try it without a key

```bash
npm run mock       # scripted OpenAI-compatible provider on :4010/v1
```

In Settings use base URL `http://127.0.0.1:4010/v1`, any key, model
`mock-agent`. The mock writes `hello.js`, runs it with Node, then summarises —
useful for checking the UI without spending tokens.

Provider calls are made by the app's own server, not the browser, so this also
works behind a hosted preview URL and avoids CORS entirely.

## Interface

The layout follows ChatGPT's: a 260px sidebar, a 768px transcript column, one
elevated surface for the composer and for your own turns, replies as plain text
with hover-only actions, and tool calls as quiet collapsible rows instead of
coloured cards. Light and dark themes are token-driven in `src/styles.css`, follow
`prefers-color-scheme` on first paint, and remember a manual choice from the
sidebar header.

## What the agent can do

| Tool | Purpose |
| --- | --- |
| `list_files` | Inspect the workspace tree (generated/dependency folders collapsed) |
| `read_file` | Read a file, line-numbered, with line-range paging |
| `write_file` | Create or overwrite a file, creating parent directories |
| `edit_file` | Exact-string replacement, with an ambiguity guard |
| `run_command` | Run bash in the workspace, streaming stdout/stderr back live |

Each conversation gets its own directory under `workspaces/<workspace-id>/`, so
chats cannot see each other's files. Paths are resolved relative to that root and
anything that escapes it is rejected.

## Architecture

```
browser (React + Vite)
   │  POST /api/chat  (fetch + server-sent events, key in the request body)
   ▼
server/index.ts  ── express, SSE framing, workspace REST API, Vite middleware in dev
   │
   ├─ server/agent.ts   streaming chat-completions client + tool loop
   └─ server/tools.ts   file + shell tools with limits and guard rails
```

* **One process, one port.** In development the Express server hosts the Vite
  middleware (including HMR) so the UI and API share an origin.
* **Stateless server.** The transcript lives in the browser; each request sends
  the history, and tool results are reconstructed from the rendered parts.
  Assistant text streams as it arrives, tool calls render as they execute.
* **Any OpenAI-compatible provider.** OpenAI, OpenRouter, Groq, vLLM, LM Studio,
  Ollama, or a gateway of your own. The model must support tool calling.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port (binds `0.0.0.0`) |
| `NODE_ENV` | – | `production` serves the built `dist/` instead of Vite |
| `PREVIEW_HOST` | – | Extra allowed host for the dev server (comma separated) |

Production build:

```bash
npm run build && npm start
```

## Security and limits

This is a local developer tool: **the shell runs with your user's permissions on
your machine.** There is no container or VM isolation.

Mitigations that are in place:

* Commands run inside the conversation's workspace directory, with a scrubbed
  environment (`HOME` is the workspace, no provider keys are exported).
* Tool output is capped (400 KB collected, 24 KB handed to the model), commands
  time out (default 30 s, max 180 s) and their whole process group is killed.
* Path traversal and absolute paths are rejected.
* A small blocklist refuses catastrophic commands (`rm -rf /`, `mkfs`, fork
  bombs, raw disk writes, power off). It is a guard rail, not a sandbox.
* The step limit per turn (default 16, configurable in Settings) bounds autonomy.
* Untrusted output from a tool is just data: the model decides what to do next,
  and you can always press Stop.

Do not expose this server to the public internet as-is.

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Dev server with HMR on port 3000 |
| `npm run build` / `npm start` | Production bundle, then serve it |
| `npm run typecheck` | `tsc --noEmit` across client and server |
| `npm run test:agent` | Tool tests + a real end-to-end agent loop against the mock provider |
| `npm run mock` | Start the scripted mock provider on :4010 |
| `npm run test:ui` | Playwright smoke test (needs `npx playwright install chromium`, the dev server and the mock provider) |

`npm run test:agent` covers nested writes, edits, unique-match enforcement, exit
codes, timeouts, the refusal guard, path traversal, SSE framing, a two-tool agent
run, and the workspace file API. `npm run test:ui` drives the real UI through
onboarding, a streamed run with tool cards, the file panel, persistence across a
reload, and the unreachable-provider error path.

## Layout

```
server/        express app, agent loop, tools, prompts
src/           React UI (components, streaming client, local storage)
scripts/       mock provider + end-to-end tests
workspaces/    per-conversation sandboxes (gitignored)
```

## Known limitations

* Tool calling must be supported by the chosen model; text-only models will
  answer without using tools.
* Streaming is not resumed after a network drop — send "continue" to carry on.
* There is no diff review gate: the agent writes files directly, as instructed.
  Use the Stop button and the workspace panel to keep an eye on it.
