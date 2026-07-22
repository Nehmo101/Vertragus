import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  activeProfile,
  useAppStore,
  workspaceAgents
} from '@renderer/store/useAppStore'
import { PROVIDER_THEME } from '@renderer/ui/theme'
import { formatTokenCount, formatUsd } from '@renderer/telemetryFormat'
import { PROVIDER_GATE_MIN, PROVIDER_GATE_MAX, type AgentProviderId } from '@shared/providers'
import type { ProviderCapacitySnapshot } from '@shared/ipc'
import { summarizeUsageGroup, TELEMETRY_STATUS_LABELS, TELEMETRY_STATUS_TITLES, type TelemetrySummary } from '@shared/telemetry'

/** All agent providers surfaced in the Limits panel (integrations excluded). */
const PANEL_PROVIDERS: AgentProviderId[] = ['claude', 'kimi', 'codex', 'cursor', 'copilot', 'ollama']

interface ProviderUsage {
  id: AgentProviderId
  active: number
  waiting: number
  limit: number
  enabled: boolean
  telemetry: TelemetrySummary
}

/**
 * Live view of Vertragus's per-provider process gates — "wie viele Agents laufen
 * gerade je Provider". Always visible on the right while a mixed team (Claude
 * + Codex + Cursor …) runs. Active/waiting counts come from the main-process
 * gate, not from provider API quota data; token/cost comes from agents.
 */
export default function LimitsPanel(): JSX.Element {
  const { t } = useTranslation()
  const store = useAppStore()
  const {
    agents,
    providerLimits: limits,
    setModelEnabled,
    setProviderEnabled,
    setProviderLimit
  } = store
  const profile = activeProfile(store)
  const visibleAgents = workspaceAgents(store)
  const [capacity, setCapacity] = useState<Record<AgentProviderId, ProviderCapacitySnapshot> | null>(
    null
  )

  useEffect(() => {
    let cancelled = false
    const refresh = (): void => {
      void window.vertragus.getProviderCapacity().then((stats) => {
        if (!cancelled) setCapacity(stats)
      }).catch(() => undefined)
    }
    refresh()
    const timer = setInterval(refresh, 5000)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [agents, limits])

  const rows: ProviderUsage[] = PANEL_PROVIDERS.map((id) => {
    const list = agents.filter((a) => a.provider === id)
    const gate = capacity?.[id]
    const active = gate?.active ?? list.filter((a) => a.status === 'running' || a.status === 'waiting').length
    const waiting = gate?.waiting ?? 0
    const telemetry = summarizeUsageGroup(list.map((agent) => agent.usage))
    return {
      id,
      active,
      waiting,
      limit: gate?.limit ?? limits[id] ?? 0,
      enabled: store.providerEnabled[id],
      telemetry
    }
  })

  const totalActive = rows.reduce((n, r) => n + r.active, 0)
  const totalWaiting = rows.reduce((n, r) => n + r.waiting, 0)
  const totalCost = rows.reduce((n, r) => n + (r.telemetry.costUsd ?? 0), 0)
  const hasCost = rows.some((r) => r.telemetry.costUsd != null)
  const configuredPrewarmed =
    profile?.agents.reduce((count, slot) => count + slot.count, 0) ?? 0
  const prewarmed = visibleAgents.filter(
    (agent) =>
      agent.kind === 'sub' &&
      agent.mode === 'interactive' &&
      Boolean(agent.teamRole) &&
      (agent.status === 'running' || agent.status === 'waiting')
  ).length
  const taskParallelism = profile?.planner.maxParallel ?? 0

  return (
    <section className="limits-panel" aria-label={t('limits.aria')}>
      <div className="limits-head">
        <span className="limits-title">{t('limits.title')}</span>
        <span className="limits-total">
          {t('limits.activeCount', { n: totalActive })}{hasCost ? ` · ${formatUsd(totalCost)}` : ''}
        </span>
      </div>
      <p className="limits-gate-note">
        {t('limits.gateNote')}
      </p>
      <div className="capacity-grid" aria-label={t('limits.capacityAria')}>
        <div className="capacity-item" title={t('limits.prewarmedTitle')}>
          <span className="capacity-label">{t('limits.prewarmed')}</span>
          <strong>{prewarmed}/{configuredPrewarmed}</strong>
          <small>{t('limits.prewarmedSub')}</small>
        </div>
        <div className="capacity-item" title={t('limits.parallelTitle')}>
          <span className="capacity-label">{t('limits.parallel')}</span>
          <strong>{taskParallelism || '—'}</strong>
          <small>{t('limits.parallelSub')}</small>
        </div>
        <div className="capacity-item" title={t('limits.activeTitle')}>
          <span className="capacity-label">{t('limits.activeProcesses')}</span>
          <strong>{totalActive}</strong>
          <small>{t('limits.activeSub')}</small>
        </div>
        <div className={`capacity-item ${totalWaiting > 0 ? 'waiting' : ''}`} title={t('limits.waitingTitle')}>
          <span className="capacity-label">{t('limits.waitingProcesses')}</span>
          <strong>{totalWaiting}</strong>
          <small>{t('limits.waitingSub')}</small>
        </div>
      </div>
      <div className="limits-subhead">
        <span>{t('limits.subhead')}</span>
        <span>{t('limits.subheadRight')}</span>
      </div>
      <div className="limits-list">
        {rows.map((r) => {
          const theme = PROVIDER_THEME[r.id]
          const limit = Math.max(PROVIDER_GATE_MIN, r.limit)
          const pct = Math.min(100, Math.round((r.active / limit) * 100))
          const over = r.active >= limit
          return (
            <div className={`limit-row ${over ? 'over' : ''} ${r.enabled ? '' : 'disabled'}`} key={r.id}>
              <span className="chip sz-22" style={{ background: theme.bg, color: theme.fg }}>
                {theme.mono}
              </span>
              <div className="limit-body">
                <div className="limit-row-top">
                  <span className="limit-name">{theme.label}</span>
                  <span className="limit-usage">
                    {r.telemetry.tokens != null && (
                      <span title={t('limits.tokensTitle', { tokens: formatTokenCount(r.telemetry.tokens) })}>
                        {t('limits.tokens', { tokens: formatTokenCount(r.telemetry.tokens) })}
                      </span>
                    )}
                    {r.telemetry.costUsd != null && <span className="cost">{formatUsd(r.telemetry.costUsd)}</span>}
                    {r.telemetry.status !== 'present' && (
                      <span className={`telemetry-status ${r.telemetry.status}`} title={TELEMETRY_STATUS_TITLES[r.telemetry.status]}>
                        {TELEMETRY_STATUS_LABELS[r.telemetry.status]}
                      </span>
                    )}
                  </span>
                </div>
                <div className="limit-bar">
                  <div
                    className="limit-bar-fill"
                    style={{ width: `${pct}%`, background: over ? 'var(--err)' : theme.fg }}
                  />
                </div>
                <details className="limit-model-gates">
                  <summary>{t('limits.modelGates')}</summary>
                  {/* data-list: several providers legitimately offer the same
                      model id, so identical labels across grids are expected. */}
                  <div className="limit-model-grid" data-list="">
                    {store.models[r.id].models.map((model) => {
                      const enabled = !store.disabledModels[r.id].some(
                        (disabled) => disabled.toLowerCase() === model.toLowerCase()
                      )
                      return (
                        <label key={model} title={model}>
                          <input
                            type="checkbox"
                            checked={enabled}
                            onChange={(event) => setModelEnabled(r.id, model, event.target.checked)}
                          />
                          <span>{model}</span>
                        </label>
                      )
                    })}
                  </div>
                </details>
              </div>
              <div className="limit-count">
                <button
                  type="button"
                  title={
                    r.enabled
                      ? t('limits.disableProvider', { name: theme.label })
                      : t('limits.enableProvider', { name: theme.label })
                  }
                  aria-pressed={r.enabled}
                  onClick={() => setProviderEnabled(r.id, !r.enabled)}
                >
                  {r.enabled ? t('limits.on') : t('limits.off')}
                </button>
                <button
                  type="button"
                  title={t('limits.decreaseGate', { name: theme.label })}
                  aria-label={t('limits.decreaseGate', { name: theme.label })}
                  disabled={limit <= PROVIDER_GATE_MIN}
                  onClick={() => setProviderLimit(r.id, Math.max(PROVIDER_GATE_MIN, limit - 1))}
                >
                  −
                </button>
                <span
                  className={`limit-count-val ${over ? 'over' : ''}`}
                  title={
                    r.waiting > 0
                      ? t('limits.countTitleWaiting', { n: r.waiting })
                      : t('limits.countTitle')
                  }
                >
                  {r.active}/{limit}
                  {r.waiting > 0 ? ` (+${r.waiting})` : ''}
                </span>
                <button
                  type="button"
                  title={t('limits.increaseGate', { name: theme.label })}
                  aria-label={t('limits.increaseGate', { name: theme.label })}
                  disabled={limit >= PROVIDER_GATE_MAX}
                  onClick={() => setProviderLimit(r.id, Math.min(PROVIDER_GATE_MAX, limit + 1))}
                >
                  +
                </button>
              </div>
            </div>
          )
        })}
      </div>
    </section>
  )
}
