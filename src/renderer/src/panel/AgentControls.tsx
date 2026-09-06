import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { EffortLevel } from '@shared/schema/provider'
import type { AgentBootDiagnostic } from '@shared/terminalBoot'
import type { ModelDiscoveryResult, ProviderListEntry, VertragusAppApi, WorkspaceAgentSummary } from '../../../preload'
import { ModelCombo, ProviderSelect } from '../profileEditor/fields'
import { rowEffortOptions } from '../profileEditor/model'
import { useSubmission } from '../lib/useDraft'

type DiagnosticAgent = WorkspaceAgentSummary & {
  providerId?: string; model?: string; effort?: EffortLevel; generation?: number
  boot?: AgentBootDiagnostic; lastError?: string
}

export function AgentControls({ agent, workspaceId, bridge }: {
  agent: DiagnosticAgent; workspaceId: string; bridge: VertragusAppApi
}): React.JSX.Element {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  return <details className="panel-agent-controls" onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary>{t('controls.title')}{agent.boot?.phase ? ` · ${t(`terminal.boot.${agent.boot.phase}`)}` : ''}{agent.lastError ? ` · ${t('controls.failed')}` : ''}</summary>
    {open ? <AgentControlForm key={`${agent.agentId}.${agent.generation ?? 0}`} agent={agent} workspaceId={workspaceId} bridge={bridge} /> : null}
  </details>
}

function AgentControlForm({ agent, workspaceId, bridge }: {
  agent: DiagnosticAgent; workspaceId: string; bridge: VertragusAppApi
}): React.JSX.Element {
  const { t } = useTranslation()
  const [providers, setProviders] = useState<ProviderListEntry[]>([])
  const [providerId, setProviderId] = useState(agent.providerId ?? '')
  const [model, setModel] = useState(agent.model ?? '')
  const [effort, setEffort] = useState<EffortLevel | ''>(agent.effort ?? '')
  const [catalogue, setCatalogue] = useState<ModelDiscoveryResult>()
  const [loadedProvider, setLoadedProvider] = useState('')
  const loading = Boolean(providerId && loadedProvider !== providerId)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const [note, setNote] = useState('')
  const action = useSubmission()
  useEffect(() => {
    let alive = true
    bridge.listProviders().then((entries) => { if (alive) setProviders(entries) }, (cause: unknown) => { if (alive) setLoadError(String(cause)) })
    return () => { alive = false }
  }, [bridge])
  useEffect(() => {
    if (!providerId) return
    let alive = true
    bridge.discoverModels(providerId).then((result) => {
      if (alive) { setCatalogue(result); setLoadedProvider(providerId); setLoadError(null) }
    }, (cause: unknown) => { if (alive) { setLoadedProvider(providerId); setLoadError(String(cause)) } })
    return () => { alive = false }
  }, [bridge, providerId])
  useEffect(() => {
    if (!agent.boot?.phase) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [agent.boot?.phase])
  const root = agent.roleId === 'orchestrator'
  const options = rowEffortOptions(model, providerId, providers, catalogue)
  const elapsed = agent.boot ? agent.boot.phase ? Math.max(agent.boot.elapsedMs, now - agent.boot.startedAt) : agent.boot.elapsedMs : undefined
  return <div className="panel-control-form">
    {elapsed !== undefined ? <p>{t('controls.elapsed', { seconds: Math.round(elapsed / 1000) })}</p> : null}
    {agent.boot?.history.length ? <ol>{agent.boot.history.map((phase, index) => <li key={`${phase.startedAt}.${index}`}>{t(`terminal.boot.${phase.phase}`)} · {Math.round((phase.durationMs ?? Math.max(0, now - phase.startedAt)) / 1000)} s</li>)}</ol> : null}
    {agent.lastError ? <p className="panel-retro-error">{agent.lastError}</p> : null}
    {agent.lastError || agent.state === 'stopped' || agent.boot?.phase === 'waiting' ? <button type="button" className="panel-answer-send" disabled={action.busy} onClick={() => void action.run(() => root ? bridge.succeedOrchestrator(workspaceId) : bridge.reseatAgent(workspaceId, { agentId: agent.agentId, reason: 'startup_retry' }))}>{t('controls.retry')}</button> : null}
    <label>{t('profileEditor.provider')}<ProviderSelect value={providerId} providers={providers} loading={providers.length === 0} onChange={(id) => { setProviderId(id); setModel(''); setEffort(''); setCatalogue(undefined) }} /></label>
    <label>{t('profileEditor.model')}<ModelCombo value={model} catalogue={catalogue} loading={loading} onChange={(value) => { setModel(value); setEffort('') }} placeholder={t('controls.keepOrDefault')} /></label>
    <label>{t('profileEditor.effort')}<select value={effort} onChange={(event) => setEffort(event.target.value as EffortLevel | '')}>
      <option value="">{t('controls.keepOrDefault')}</option>
      {options.map((level) => <option key={level} value={level}>{level}</option>)}
    </select></label>
    {!root ? <label>{t('controls.note')}<textarea value={note} rows={2} onChange={(event) => setNote(event.target.value)} maxLength={2000} /></label> : null}
    <p className="panel-retro-note">{t('controls.switchHint')}</p>
    <button type="button" className="panel-answer-send" disabled={action.busy || !providerId} onClick={() => void action.run(() => {
      const seat = { providerId, ...(model.trim() ? { model: model.trim() } : {}), ...(effort ? { effort } : {}) }
      return root ? bridge.succeedOrchestrator(workspaceId, seat) : bridge.reseatAgent(workspaceId, { agentId: agent.agentId, ...seat, reason: 'user_request', ...(note.trim() ? { note: note.trim() } : {}) })
    })}>{t('controls.switch')}</button>
    {loadError || action.error ? <p className="panel-retro-error" role="alert">{action.error ?? loadError}</p> : null}
  </div>
}
