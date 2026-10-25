import { useEffect, useState } from 'react'
import { Check, Eye, EyeOff, KeyRound, Loader2, X, XCircle, Zap } from 'lucide-react'
import type { Settings } from '../lib/types'
import { isLocalBaseUrl, providerPresets } from '../lib/format'
import { testProvider } from '../lib/api'

export function SettingsDialog({
  settings,
  onSave,
  onClose,
}: {
  settings: Settings
  onSave: (settings: Settings) => void
  onClose: () => void
}) {
  const [draft, setDraft] = useState<Settings>(settings)
  const [showKey, setShowKey] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [testing, setTesting] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; message: string; elapsedMs?: number } | null>(null)

  const preset = providerPresets.find((item) => item.baseUrl && item.baseUrl === draft.baseUrl)
  const needsKey = !isLocalBaseUrl(draft.baseUrl)

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const save = () => {
    if (!/^https?:\/\//i.test(draft.baseUrl.trim())) {
      setError('The base URL must start with http:// or https://')
      return
    }
    if (!draft.model.trim()) {
      setError('Choose a model name.')
      return
    }
    onSave({
      ...draft,
      baseUrl: draft.baseUrl.trim().replace(/\/+$/, ''),
      model: draft.model.trim(),
      apiKey: draft.apiKey.trim(),
    })
    onClose()
  }

  const runTest = async () => {
    setTesting(true)
    setResult(null)
    const outcome = await testProvider(draft)
    setResult(outcome)
    setTesting(false)
  }

  return (
    <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label="Settings">
        <div className="modal-head">
          <div>
            <h2>Provider settings</h2>
            <p>Keys stay in this browser. The local server only forwards them to the provider you pick.</p>
          </div>
          <button type="button" className="icon-btn" onClick={onClose} title="Close">
            <X size={16} />
          </button>
        </div>

        <div className="modal-body">
          <label className="field-label">Provider</label>
          <div className="preset-row">
            {providerPresets.map((item) => (
              <button
                key={item.id}
                type="button"
                className={`preset ${preset?.id === item.id ? 'active' : ''}`}
                onClick={() => {
                  setResult(null)
                  setDraft((current) => ({
                    ...current,
                    baseUrl: item.baseUrl || current.baseUrl,
                    model: item.models[0] ?? current.model,
                  }))
                }}
              >
                {item.label}
              </button>
            ))}
          </div>

          <label className="field-label" htmlFor="base-url">
            Base URL
          </label>
          <input
            id="base-url"
            className="text-input mono"
            value={draft.baseUrl}
            spellCheck={false}
            placeholder="https://api.openai.com/v1"
            onChange={(event) => {
              setResult(null)
              setDraft({ ...draft, baseUrl: event.target.value })
            }}
          />
          <p className="field-hint">
            Any OpenAI-compatible endpoint works — OpenAI, OpenRouter, Groq, vLLM, LM Studio, Ollama.
            The app appends <code>/chat/completions</code>.
          </p>

          <label className="field-label" htmlFor="api-key">
            API key {needsKey ? '' : '(optional for local servers)'}
          </label>
          <div className="input-row">
            <div className="input-affix">
              <KeyRound size={14} />
              <input
                id="api-key"
                type={showKey ? 'text' : 'password'}
                value={draft.apiKey}
                spellCheck={false}
                autoComplete="off"
                placeholder="sk-…"
                onChange={(event) => {
                  setResult(null)
                  setDraft({ ...draft, apiKey: event.target.value })
                }}
              />
              <button
                type="button"
                className="icon-btn tiny"
                title={showKey ? 'Hide key' : 'Show key'}
                onClick={() => setShowKey((value) => !value)}
              >
                {showKey ? <EyeOff size={14} /> : <Eye size={14} />}
              </button>
            </div>
          </div>

          <label className="field-label" htmlFor="model">
            Model
          </label>
          <input
            id="model"
            className="text-input mono"
            value={draft.model}
            spellCheck={false}
            list="model-options"
            placeholder="gpt-4o-mini"
            onChange={(event) => {
              setResult(null)
              setDraft({ ...draft, model: event.target.value })
            }}
          />
          <datalist id="model-options">
            {(preset?.models ?? []).map((model) => (
              <option key={model} value={model} />
            ))}
          </datalist>

          <label className="field-label" htmlFor="max-steps">
            Agent step limit per turn
          </label>
          <div className="range-row">
            <input
              id="max-steps"
              type="range"
              min={4}
              max={40}
              step={2}
              value={draft.maxSteps}
              onChange={(event) => setDraft({ ...draft, maxSteps: Number(event.target.value) })}
            />
            <span className="range-value">{draft.maxSteps}</span>
          </div>
          <p className="field-hint">
            How many model round-trips the agent may take before it pauses. Higher means longer autonomous
            runs.
          </p>

          {result ? (
            <div className={`test-result ${result.ok ? 'ok' : 'fail'}`}>
              {result.ok ? <Check size={14} /> : <XCircle size={14} />}
              <span>
                {result.message}
                {result.ok && result.elapsedMs ? ` · ${result.elapsedMs} ms` : ''}
              </span>
            </div>
          ) : null}
          {error ? <div className="test-result fail">{error}</div> : null}
        </div>

        <div className="modal-foot">
          <button type="button" className="btn ghost" onClick={runTest} disabled={testing}>
            {testing ? <Loader2 size={14} className="spin" /> : <Zap size={14} />}
            {testing ? 'Testing…' : 'Test connection'}
          </button>
          <div className="modal-foot-right">
            <button type="button" className="btn ghost" onClick={onClose}>
              Cancel
            </button>
            <button type="button" className="btn primary" onClick={save}>
              Save
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
