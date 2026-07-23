import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '@renderer/store/useAppStore'
import InfoTip from '@renderer/components/InfoTip'
import {
  MCP_NAME_PATTERN,
  MCP_SCOPE_LABELS,
  MCP_SCOPES,
  MCP_TRANSPORT_LABELS,
  MCP_TRANSPORTS,
  type McpScope,
  type McpServerConfig,
  type McpTransport
} from '@shared/mcp'

/** Editor row model: keeps args/env/headers as raw text while editing. */
interface Draft {
  id: string
  name: string
  enabled: boolean
  transport: McpTransport
  scope: McpScope
  command: string
  argsText: string
  envText: string
  url: string
  headersText: string
}

// Translation key paths; the German/English copy lives in the locale files.
const HELP = {
  intro: 'mcpEditor.help.intro',
  name: 'mcpEditor.help.name',
  transport: 'mcpEditor.help.transport',
  scope: 'mcpEditor.help.scope',
  command: 'mcpEditor.help.command',
  args: 'mcpEditor.help.args',
  env: 'mcpEditor.help.env',
  url: 'mcpEditor.help.url',
  headers: 'mcpEditor.help.headers'
} as const

function parseLines(text: string): string[] {
  return text.split('\n').map((line) => line.trim()).filter(Boolean)
}

function parsePairs(text: string, separator: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of parseLines(text)) {
    const at = line.indexOf(separator)
    if (at <= 0) continue
    out[line.slice(0, at).trim()] = line.slice(at + separator.length).trim()
  }
  return out
}

function formatPairs(record: Record<string, string>, separator: string): string {
  return Object.entries(record)
    .map(([key, value]) => `${key}${separator}${value}`)
    .join('\n')
}

function toDraft(server: McpServerConfig): Draft {
  return {
    id: server.id,
    name: server.name,
    enabled: server.enabled,
    transport: server.transport,
    scope: server.scope,
    command: server.command,
    argsText: server.args.join('\n'),
    envText: formatPairs(server.env, '='),
    url: server.url,
    headersText: formatPairs(server.headers, ': ')
  }
}

function toConfig(draft: Draft): McpServerConfig {
  return {
    id: draft.id,
    name: draft.name.trim(),
    enabled: draft.enabled,
    transport: draft.transport,
    scope: draft.scope,
    command: draft.command.trim(),
    args: parseLines(draft.argsText),
    env: parsePairs(draft.envText, '='),
    url: draft.url.trim(),
    headers: parsePairs(draft.headersText, ':')
  }
}

function emptyDraft(): Draft {
  return {
    id: `mcp-${Date.now().toString(36)}-${Math.floor(performance.now())}`,
    name: '',
    enabled: true,
    transport: 'stdio',
    scope: 'all',
    command: '',
    argsText: '',
    envText: '',
    url: '',
    headersText: ''
  }
}

/** Inline validation message for one row, or '' when the row is valid. */
function rowError(t: TFunction, draft: Draft, all: Draft[]): string {
  const name = draft.name.trim()
  if (!name) return t('mcpEditor.errors.nameMissing')
  if (!MCP_NAME_PATTERN.test(name)) return t('mcpEditor.errors.nameInvalid')
  if (all.some((other) => other.id !== draft.id && other.name.trim() === name)) {
    return t('mcpEditor.errors.nameDuplicate', { name })
  }
  if (draft.transport === 'stdio' && !draft.command.trim()) return t('mcpEditor.errors.commandMissing')
  if (draft.transport !== 'stdio' && !draft.url.trim()) return t('mcpEditor.errors.urlMissing')
  return ''
}

export default function McpServerEditor(): JSX.Element | null {
  const { t } = useTranslation()
  // Narrow pick — the modal only needs the MCP list and its own actions.
  const store = useAppStore(
    useShallow((s) => ({
      mcpServers: s.mcpServers,
      saveMcpServers: s.saveMcpServers,
      closeMcpEditor: s.closeMcpEditor
    }))
  )
  const [drafts, setDrafts] = useState<Draft[]>(() => store.mcpServers.map(toDraft))
  const closeMcpEditor = store.closeMcpEditor

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') closeMcpEditor()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [closeMcpEditor])

  const patch = (idx: number, part: Partial<Draft>): void =>
    setDrafts(drafts.map((draft, i) => (i === idx ? { ...draft, ...part } : draft)))
  const remove = (idx: number): void => setDrafts(drafts.filter((_, i) => i !== idx))
  const add = (): void => setDrafts([...drafts, emptyDraft()])

  const errors = drafts.map((draft) => rowError(t, draft, drafts))
  const firstError = errors.find(Boolean)
  const enabledCount = drafts.filter((d) => d.enabled).length

  const save = (): void => {
    if (firstError) return
    void store.saveMcpServers(drafts.map(toConfig))
  }

  return (
    <div className="modal-wrap">
      <div className="modal-scrim" onClick={store.closeMcpEditor} />
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="mcp-editor-title">
        <div className="modal-head">
          <span className="modal-gear">🔌</span>
          <div style={{ flex: 1 }}>
            <div className="modal-title" id="mcp-editor-title">
              {t('mcpEditor.title')}
            </div>
            <div className="modal-sub">{t('mcpEditor.sub')}</div>
          </div>
          <button
            type="button"
            className="modal-close"
            aria-label={t('mcpEditor.closeAria')}
            onClick={store.closeMcpEditor}
          >
            ✕
          </button>
        </div>

        <div className="modal-body">
          <p className="mcp-intro">{t(HELP.intro)}</p>

          <div className="slots-caption">
            <span>{t('mcpEditor.server')}</span>
            <span className="count">
              {t('mcpEditor.count', { total: drafts.length, active: enabledCount })}
            </span>
          </div>

          {drafts.length === 0 && (
            <div className="single-hint">
              {t('mcpEditor.emptyHint')}
            </div>
          )}

          <div className="mcp-list">
            {drafts.map((draft, idx) => (
              <div className="mcp-card" key={draft.id}>
                <div className="mcp-card-head">
                  <button
                    type="button"
                    className={`ctrl-check ${draft.enabled ? 'on' : ''}`}
                    title={draft.enabled ? t('mcpEditor.enabledOn') : t('mcpEditor.enabledOff')}
                    aria-label={draft.enabled ? t('mcpEditor.disableAria') : t('mcpEditor.enableAria')}
                    onClick={() => patch(idx, { enabled: !draft.enabled })}
                  >
                    {draft.enabled ? '✓' : ''}
                  </button>
                  <div className="mcp-name-field">
                    <div className="slot-col-label">
                      {t('mcpEditor.nameLabel')} <InfoTip text={t(HELP.name)} />
                    </div>
                    <input
                      className="slot-select-sm mono"
                      placeholder={t('mcpEditor.namePlaceholder')}
                      value={draft.name}
                      onChange={(e) => patch(idx, { name: e.target.value })}
                    />
                  </div>
                  <div className="mcp-transport-field">
                    <div className="slot-col-label">
                      {t('mcpEditor.transportLabel')} <InfoTip text={t(HELP.transport)} />
                    </div>
                    <select
                      className="slot-select-sm"
                      value={draft.transport}
                      onChange={(e) => patch(idx, { transport: e.target.value as McpTransport })}
                    >
                      {MCP_TRANSPORTS.map((t) => (
                        <option key={t} value={t}>
                          {MCP_TRANSPORT_LABELS[t]}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="mcp-scope-field">
                    <div className="slot-col-label">
                      {t('mcpEditor.scopeLabel')} <InfoTip text={t(HELP.scope)} />
                    </div>
                    <select
                      className="slot-select-sm"
                      value={draft.scope}
                      onChange={(e) => patch(idx, { scope: e.target.value as McpScope })}
                    >
                      {MCP_SCOPES.map((s) => (
                        <option key={s} value={s}>
                          {MCP_SCOPE_LABELS[s]}
                        </option>
                      ))}
                    </select>
                  </div>
                  <button
                    type="button"
                    className="slot-remove"
                    title={t('mcpEditor.removeTitle')}
                    aria-label={t('mcpEditor.removeAria', { name: draft.name || idx + 1 })}
                    onClick={() => remove(idx)}
                  >
                    ✕
                  </button>
                </div>

                {draft.transport === 'stdio' ? (
                  <div className="mcp-fields">
                    <label className="mcp-field-wide">
                      <span className="slot-col-label">
                        {t('mcpEditor.commandLabel')} <InfoTip text={t(HELP.command)} />
                      </span>
                      <input
                        className="slot-select-sm mono"
                        placeholder="npx"
                        value={draft.command}
                        onChange={(e) => patch(idx, { command: e.target.value })}
                      />
                    </label>
                    <label className="mcp-field-wide">
                      <span className="slot-col-label">
                        {t('mcpEditor.argsLabel')} <InfoTip text={t(HELP.args)} />
                      </span>
                      <textarea
                        className="text-input mono mcp-textarea"
                        placeholder={t('mcpEditor.argsPlaceholder')}
                        value={draft.argsText}
                        onChange={(e) => patch(idx, { argsText: e.target.value })}
                      />
                    </label>
                    <label className="mcp-field-wide">
                      <span className="slot-col-label">
                        {t('mcpEditor.envLabel')} <InfoTip text={t(HELP.env)} />
                      </span>
                      <textarea
                        className="text-input mono mcp-textarea"
                        placeholder={'API_KEY=…'}
                        value={draft.envText}
                        onChange={(e) => patch(idx, { envText: e.target.value })}
                      />
                    </label>
                  </div>
                ) : (
                  <div className="mcp-fields">
                    <label className="mcp-field-wide">
                      <span className="slot-col-label">
                        {t('mcpEditor.urlLabel')} <InfoTip text={t(HELP.url)} />
                      </span>
                      <input
                        className="slot-select-sm mono"
                        placeholder="https://host/mcp"
                        value={draft.url}
                        onChange={(e) => patch(idx, { url: e.target.value })}
                      />
                    </label>
                    <label className="mcp-field-wide">
                      <span className="slot-col-label">
                        {t('mcpEditor.headersLabel')} <InfoTip text={t(HELP.headers)} />
                      </span>
                      <textarea
                        className="text-input mono mcp-textarea"
                        placeholder={'Authorization: Bearer …'}
                        value={draft.headersText}
                        onChange={(e) => patch(idx, { headersText: e.target.value })}
                      />
                    </label>
                  </div>
                )}

                {errors[idx] && (
                  <div className="mcp-row-error" role="alert">
                    ⚠ {errors[idx]}
                  </div>
                )}
              </div>
            ))}
          </div>

          <button type="button" className="add-slot" onClick={add}>
            {t('mcpEditor.addServer')}
          </button>
        </div>

        <div className="modal-foot">
          <div className="totals">
            {firstError ? (
              <span className="mcp-foot-error">⚠ {firstError}</span>
            ) : (
              <>
                <b>{enabledCount}</b> {t('mcpEditor.footActive')}
              </>
            )}
          </div>
          <button type="button" className="btn-secondary" onClick={store.closeMcpEditor}>
            {t('mcpEditor.cancel')}
          </button>
          <button type="button" className="btn-primary" disabled={Boolean(firstError)} onClick={save}>
            {t('mcpEditor.save')}
          </button>
        </div>
      </div>
    </div>
  )
}
