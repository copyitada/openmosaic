import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const SERVER_DIR = path.dirname(fileURLToPath(import.meta.url))
export const PROJECT_ROOT = path.resolve(SERVER_DIR, '..')
export const WORKSPACES_ROOT = path.join(PROJECT_ROOT, 'workspaces')

/** Accepts a client-supplied workspace id and turns it into a safe directory. */
export function workspaceDir(id: unknown): string {
  const raw = typeof id === 'string' ? id : ''
  const safe = raw.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64)
  if (!safe) throw new HttpError(400, 'A valid workspaceId is required.')
  return path.join(WORKSPACES_ROOT, safe)
}

/** Resolves a model-supplied relative path, refusing anything outside the workspace. */
export function resolveInWorkspace(root: string, relative: unknown): string {
  if (typeof relative !== 'string' || relative.trim() === '') {
    throw new HttpError(400, 'path must be a non-empty string (use "." for the workspace root).')
  }
  const normalized = relative.trim()
  if (path.isAbsolute(normalized)) {
    throw new HttpError(
      400,
      `Absolute paths are not allowed. Paths are relative to the workspace root, which is ${root}.`,
    )
  }
  const resolved = path.resolve(root, normalized)
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new HttpError(400, `Path "${relative}" escapes the workspace root.`)
  }
  return resolved
}

/** Path shown to the model / UI, always posix style relative to the workspace. */
export function toWorkspacePath(root: string, absolute: string): string {
  const rel = path.relative(root, absolute)
  return rel === '' ? '.' : rel.split(path.sep).join('/')
}

export class HttpError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}
