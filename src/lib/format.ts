export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`
  const minutes = Math.floor(ms / 60_000)
  const seconds = Math.round((ms % 60_000) / 1000)
  return `${minutes}m ${seconds}s`
}

export function formatBytes(bytes?: number): string {
  if (bytes === undefined) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export const toolLabels: Record<string, string> = {
  run_command: 'Ran command',
  write_file: 'Wrote file',
  edit_file: 'Edited file',
  read_file: 'Read file',
  list_files: 'Listed files',
}

export function toolLabel(name: string): string {
  return toolLabels[name] ?? name.replace(/_/g, ' ')
}

export type ProviderPreset = {
  id: string
  label: string
  baseUrl: string
  models: string[]
  needsKey: boolean
}

export const providerPresets: ProviderPreset[] = [
  {
    id: 'openai',
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    models: ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1', 'gpt-4.1-mini', 'o4-mini'],
    needsKey: true,
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    models: [
      'openai/gpt-4o-mini',
      'anthropic/claude-sonnet-4',
      'google/gemini-2.5-flash',
      'qwen/qwen3-coder',
      'deepseek/deepseek-chat',
    ],
    needsKey: true,
  },
  {
    id: 'groq',
    label: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    models: ['llama-3.3-70b-versatile', 'moonshotai/kimi-k2-instruct'],
    needsKey: true,
  },
  {
    id: 'ollama',
    label: 'Ollama (local)',
    baseUrl: 'http://localhost:11434/v1',
    models: ['qwen2.5-coder:7b', 'llama3.1:8b', 'devstral:24b'],
    needsKey: false,
  },
  {
    id: 'custom',
    label: 'Custom',
    baseUrl: '',
    models: [],
    needsKey: true,
  },
]

export function isLocalBaseUrl(baseUrl: string): boolean {
  return /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:|\/|$)/i.test(baseUrl.trim())
}
