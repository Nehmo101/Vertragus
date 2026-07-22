import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useAppStore } from '@renderer/store/useAppStore'
import { LIMIT_KIND_LABELS, type AgentInstanceInfo } from '@shared/agents'
import type { AgentProviderId } from '@shared/providers'
import { PROVIDER_THEME } from '@renderer/ui/theme'
import ModelCatalogStatus from '@renderer/components/ModelCatalogStatus'
import { defaultHandoffModel } from '@renderer/modelCatalog'

const AGENT_PROVIDERS: AgentProviderId[] = ['claude', 'kimi', 'codex', 'cursor', 'copilot', 'ollama']

function collectEligibleSources(
  source: AgentInstanceInfo,
  agents: AgentInstanceInfo[]
): AgentInstanceInfo[] {
  return agents.filter(
    (agent) =>
      agent.provider === source.provider &&
      agent.profileId === source.profileId &&
      agent.workspaceSessionId === source.workspaceSessionId &&
      agent.mode === 'interactive' &&
      agent.status === 'running' &&
      !agent.handoffTo
  )
}

export default function HandoffModal(): JSX.Element | null {
  const { t } = useTranslation()
  // Narrow store slices: a whole-store subscribe re-renders on every agents.onChanged
  // tick and collapses Chromium's native <select> while the user is picking.
  const source = useAppStore((s) => s.handoffSource)
  const models = useAppStore((s) => s.models)
  const closeHandoff = useAppStore((s) => s.closeHandoff)
  const handoff = useAppStore((s) => s.handoff)
  const bulkHandoff = useAppStore((s) => s.bulkHandoff)
  const goalTitle = useAppStore((s) => s.orchestrator.goal?.title ?? '')

  const catalogFor = (p: AgentProviderId) => models[p]
  const modelsFor = (p: AgentProviderId): string[] => catalogFor(p).models
  // Cloud CLIs decide when the field is empty. Ollama has no model-less mode,
  // so select the first locally discovered model there.
  const defaultModelFor = (p: AgentProviderId): string =>
    defaultHandoffModel(p, catalogFor(p))

  const [provider, setProvider] = useState<AgentProviderId>('codex')
  const [model, setModel] = useState<string>(() =>
    defaultHandoffModel('codex', useAppStore.getState().models.codex)
  )
  const [task, setTask] = useState<string>(goalTitle)
  const [summary, setSummary] = useState<string>('')
  const [bulk, setBulk] = useState(false)
  const taskRef = useRef<HTMLTextAreaElement>(null)
  // Freeze the bulk cohort at open time — live `agents` would re-render this modal.
  const [eligibleSources] = useState<AgentInstanceInfo[]>(() => {
    const state = useAppStore.getState()
    return state.handoffSource
      ? collectEligibleSources(state.handoffSource, state.agents)
      : []
  })

  useEffect(() => {
    taskRef.current?.focus()
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        setBulk(false)
        closeHandoff()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [closeHandoff])

  if (!source) return null

  const limit = source.limitWarning
  const srcTheme = PROVIDER_THEME[source.provider]

  const submit = (): void => {
    setBulk(false)
    if (bulk) {
      void bulkHandoff({
        sourceIds: eligibleSources.map((agent) => agent.id),
        provider, model, task, summary, stopSources: true
      })
      return
    }
    void handoff({ sourceId: source.id, provider, model, task, summary })
  }

  return (
    <div className="modal-wrap">
      <div className="modal-scrim" onClick={() => { setBulk(false); closeHandoff() }} />
      <div className="modal handoff-modal" role="dialog" aria-modal="true" aria-labelledby="handoff-title">
        <div className="modal-head">
          <span className="modal-gear">⇄</span>
          <div style={{ flex: 1 }}>
            <div className="modal-title" id="handoff-title">{t('modals.handoff.title')}</div>
            <div className="modal-sub">{t('modals.handoff.sub')}</div>
          </div>
          <button type="button" className="modal-close" aria-label={t('modals.handoff.closeAria')} onClick={() => { setBulk(false); closeHandoff() }}>
            ✕
          </button>
        </div>

        <div className="modal-body">
          <div className="handoff-source">
            <span className="chip sz-27" style={{ background: srcTheme.bg, color: srcTheme.fg }}>
              {srcTheme.mono}
            </span>
            <div className="info">
              <div className="name">
                {source.name}
                <span className="sub"> · {srcTheme.label}/{source.model || t('modals.handoff.cliDefault')}</span>
              </div>
              <div className="reason">
                {limit
                  ? t('modals.handoff.limitDetected', { kind: LIMIT_KIND_LABELS[limit.kind] })
                  : t('modals.handoff.manual')} — {source.role}
              </div>
            </div>
          </div>

          {eligibleSources.length > 1 ? (
            <label className="handoff-note" style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
              <input
                type="checkbox"
                checked={bulk}
                onChange={(event) => setBulk(event.target.checked)}
              />
              <span>
                {t('modals.handoff.bulkLabel', {
                  n: eligibleSources.length,
                  provider: srcTheme.label
                })}
              </span>
            </label>
          ) : null}

          <div className="handoff-target-row">
            <div style={{ flex: 1 }}>
              <div className="select-label">{t('modals.handoff.targetProvider')}</div>
              <select
                className="slot-select-sm"
                value={provider}
                onChange={(e) => {
                  const p = e.target.value as AgentProviderId
                  setProvider(p)
                  setModel(defaultModelFor(p))
                }}
              >
                {AGENT_PROVIDERS.map((p) => (
                  <option key={p} value={p}>
                    {PROVIDER_THEME[p].label}
                  </option>
                ))}
              </select>
            </div>
            <div style={{ flex: 1.4 }}>
              <div className="select-label">{t('modals.handoff.model')}</div>
              <input
                className="slot-select-sm mono"
                list="handoff-models"
                placeholder={t('modals.handoff.cliDefault')}
                value={model}
                onChange={(e) => setModel(e.target.value)}
              />
              <datalist id="handoff-models">
                {modelsFor(provider).map((m) => (
                  <option key={m} value={m} />
                ))}
              </datalist>
              <ModelCatalogStatus provider={provider} catalog={catalogFor(provider)} />
            </div>
          </div>

          <label className="field-label" htmlFor="handoff-task">{t('modals.handoff.taskLabel')}</label>
          <textarea
            id="handoff-task"
            ref={taskRef}
            className="text-input handoff-text"
            placeholder={t('modals.handoff.taskPlaceholder')}
            value={task}
            onChange={(e) => setTask(e.target.value)}
          />

          <label className="field-label" htmlFor="handoff-summary">{t('modals.handoff.summaryLabel')}</label>
          <textarea
            id="handoff-summary"
            className="text-input handoff-text"
            placeholder={t('modals.handoff.summaryPlaceholder')}
            value={summary}
            onChange={(e) => setSummary(e.target.value)}
          />

          <div className="handoff-note">
            {bulk
              ? t('modals.handoff.noteBulk', { n: eligibleSources.length })
              : t('modals.handoff.noteSingle', { name: source.name })}{' '}
            {t('modals.handoff.noteCwd')}
            {!bulk && source.kind === 'orchestrator'
              ? ` ${t('modals.handoff.noteOrchestrator', { name: source.name })}`
              : !bulk ? ` ${t('modals.handoff.noteMarked', { name: source.name })}` : ''}
          </div>
        </div>

        <div className="modal-foot">
          <div className="spacer" />
          <button type="button" className="btn-secondary" onClick={() => { setBulk(false); closeHandoff() }}>
            {t('modals.handoff.cancel')}
          </button>
          <button type="button" className="btn-primary" onClick={submit}>
            ⇄ {bulk
              ? t('modals.handoff.submitBulk', { n: eligibleSources.length })
              : t('modals.handoff.submit')}
          </button>
        </div>
      </div>
    </div>
  )
}
