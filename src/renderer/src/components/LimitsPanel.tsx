import { useEffect, useState } from 'react'
import {
  activeProfile,
  useAppStore,
  workspaceAgents
} from '@renderer/store/useAppStore'
import { PROVIDER_THEME } from '@renderer/ui/theme'
import { PROVIDER_GATE_MAX, PROVIDER_GATE_MIN, type AgentProviderId } from '@shared/providers'
import type { ProviderCapacitySnapshot } from '@shared/ipc'
import { summarizeUsageGroup, TELEMETRY_STATUS_LABELS, TELEMETRY_STATUS_TITLES, type TelemetrySummary } from '@shared/telemetry'

/** All agent providers surfaced in the Limits panel (integrations excluded). */
const PANEL_PROVIDERS: AgentProviderId[] = ['claude', 'codex', 'cursor', 'copilot', 'ollama']

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 10_000) return `${Math.round(n / 1000)}k`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return String(n)
}

interface ProviderUsage {
  id: AgentProviderId
  active: number
  waiting: number
  limit: number
  telemetry: TelemetrySummary
}

/**
 * Live view of Orca's per-provider process gates — "wie viele Agents laufen
 * gerade je Provider". Always visible on the right while a mixed team (Claude
 * + Codex + Cursor …) runs. Active/waiting counts come from the main-process
 * gate, not from provider API quota data; token/cost comes from agents.
 */
export default function LimitsPanel(): JSX.Element {
  const store = useAppStore()
  const { agents, providerLimits: limits, setProviderLimit } = store
  const profile = activeProfile(store)
  const visibleAgents = workspaceAgents(store)
  const [capacity, setCapacity] = useState<Record<AgentProviderId, ProviderCapacitySnapshot> | null>(
    null
  )

  useEffect(() => {
    let cancelled = false
    const refresh = (): void => {
      void window.orca.getProviderCapacity().then((stats) => {
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
    <section className="limits-panel" aria-label="Orca-interne Provider-Gates">
      <div className="limits-head">
        <span className="limits-title">Orca-Gates</span>
        <span className="limits-total">
          {totalActive} aktiv{hasCost ? ` · $${totalCost.toFixed(2)}` : ''}
        </span>
      </div>
      <p className="limits-gate-note">
        Lokale Parallelitätsgrenzen für Orca-Prozesse · keine API- oder Nutzungsquoten.
      </p>
      <div className="capacity-grid" aria-label="Einheitliches Kapazitätsmodell">
        <div className="capacity-item" title="Vorgewärmte, interaktive Team-Agents im aktuellen Workspace">
          <span className="capacity-label">Vorgewärmt</span>
          <strong>{prewarmed}/{configuredPrewarmed}</strong>
          <small>interaktiv · Workspace</small>
        </div>
        <div className="capacity-item" title="Maximale parallele Tasks laut Planner-Profil">
          <span className="capacity-label">Task-Parallelität</span>
          <strong>{taskParallelism || '—'}</strong>
          <small>Maximum · Workspace</small>
        </div>
        <div className="capacity-item" title="Prozesse, die aktuell einen Provider-Slot belegen">
          <span className="capacity-label">Aktive Prozesse</span>
          <strong>{totalActive}</strong>
          <small>global · alle Provider</small>
        </div>
        <div className={`capacity-item ${totalWaiting > 0 ? 'waiting' : ''}`} title="Prozesse in der globalen Provider-Warteschlange">
          <span className="capacity-label">Wartende Prozesse</span>
          <strong>{totalWaiting}</strong>
          <small>global · Provider-Gate</small>
        </div>
      </div>
      <div className="limits-subhead">
        <span>Konfigurierbare Provider-Gates</span>
        <span>aktiv / Gate (+ wartend)</span>
      </div>
      <div className="limits-list">
        {rows.map((r) => {
          const theme = PROVIDER_THEME[r.id]
          const pct = r.limit > 0 ? Math.min(100, Math.round((r.active / r.limit) * 100)) : 0
          const over = r.limit > 0 && r.active >= r.limit
          return (
            <div className={`limit-row ${over ? 'over' : ''}`} key={r.id}>
              <span className="chip sz-22" style={{ background: theme.bg, color: theme.fg }}>
                {theme.mono}
              </span>
              <div className="limit-body">
                <div className="limit-row-top">
                  <span className="limit-name">{theme.label}</span>
                  <span className="limit-usage">
                    {r.telemetry.tokens != null && (
                      <span title={`${r.telemetry.tokens.toLocaleString()} Tokens (Eingabe + Ausgabe)`}>
                        {fmtTokens(r.telemetry.tokens)} Tokens
                      </span>
                    )}
                    {r.telemetry.costUsd != null && <span className="cost">${r.telemetry.costUsd.toFixed(2)}</span>}
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
              </div>
              <div className="limit-count">
                <button
                  type="button"
                  title={`${theme.label}-Orca-Gate verringern`}
                  aria-label={`${theme.label}-Orca-Gate verringern`}
                  disabled={r.limit <= PROVIDER_GATE_MIN}
                  onClick={() => setProviderLimit(r.id, r.limit - 1)}
                >
                  −
                </button>
                <span
                  className={`limit-count-val ${over ? 'over' : ''}`}
                  title={
                    r.waiting > 0
                      ? `${r.waiting} wartend · aktiv / Orca-Gate (keine API-Quote)`
                      : 'aktiv / Orca-Gate (keine API-Quote)'
                  }
                >
                  {r.active}/{r.limit}
                  {r.waiting > 0 ? ` (+${r.waiting})` : ''}
                </span>
                <button
                  type="button"
                  title={`${theme.label}-Orca-Gate erhöhen`}
                  aria-label={`${theme.label}-Orca-Gate erhöhen`}
                  disabled={r.limit >= PROVIDER_GATE_MAX}
                  onClick={() => setProviderLimit(r.id, r.limit + 1)}
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
