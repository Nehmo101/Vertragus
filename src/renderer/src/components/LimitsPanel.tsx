import { useAppStore } from '@renderer/store/useAppStore'
import { PROVIDER_THEME } from '@renderer/ui/theme'
import type { AgentProviderId } from '@shared/providers'

/** Agent providers surfaced in the Limits panel (integrations excluded). */
const PANEL_PROVIDERS: AgentProviderId[] = ['claude', 'codex', 'cursor', 'ollama']

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 10_000) return `${Math.round(n / 1000)}k`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return String(n)
}

interface ProviderUsage {
  id: AgentProviderId
  running: number
  waiting: number
  tokens: number
  cost: number
  limit: number
}

/**
 * Live per-provider budget view — "wie viele Agents laufen gerade je Provider,
 * und wie viel verbrauchen sie". Always visible on the right so the user can see
 * their limits at a glance while a mixed team (Claude + Codex + Cursor …) runs.
 * The per-provider limit is an editable concurrency budget persisted to config.
 */
export default function LimitsPanel(): JSX.Element {
  const agents = useAppStore((s) => s.agents)
  const limits = useAppStore((s) => s.providerLimits)
  const setProviderLimit = useAppStore((s) => s.setProviderLimit)

  const rows: ProviderUsage[] = PANEL_PROVIDERS.map((id) => {
    const list = agents.filter((a) => a.provider === id)
    const running = list.filter((a) => a.status === 'running').length
    const waiting = list.filter((a) => a.status === 'waiting').length
    const tokens = list.reduce(
      (n, a) => n + (a.usage?.tokensIn ?? 0) + (a.usage?.tokensOut ?? 0),
      0
    )
    const cost = list.reduce((n, a) => n + (a.usage?.costUsd ?? 0), 0)
    return { id, running, waiting, tokens, cost, limit: limits[id] ?? 0 }
  })

  const totalActive = rows.reduce((n, r) => n + r.running + r.waiting, 0)
  const totalCost = rows.reduce((n, r) => n + r.cost, 0)

  return (
    <section className="limits-panel" aria-label="Limits und Nutzung">
      <div className="limits-head">
        <span className="limits-title">Limits &amp; Nutzung</span>
        <span className="limits-total">
          {totalActive} aktiv{totalCost > 0 ? ` · $${totalCost.toFixed(2)}` : ''}
        </span>
      </div>
      <div className="limits-list">
        {rows.map((r) => {
          const theme = PROVIDER_THEME[r.id]
          const pct = r.limit > 0 ? Math.min(100, Math.round((r.running / r.limit) * 100)) : 0
          const over = r.limit > 0 && r.running >= r.limit
          const countLabel =
            r.waiting > 0 ? `${r.running}+${r.waiting}` : String(r.running)
          return (
            <div className={`limit-row ${over ? 'over' : ''}`} key={r.id}>
              <span className="chip sz-22" style={{ background: theme.bg, color: theme.fg }}>
                {theme.mono}
              </span>
              <div className="limit-body">
                <div className="limit-row-top">
                  <span className="limit-name">{theme.label}</span>
                  <span className="limit-usage">
                    {r.tokens > 0 && (
                      <span title={`${r.tokens.toLocaleString()} Tokens (Eingabe + Ausgabe)`}>
                        {fmtTokens(r.tokens)} Tok
                      </span>
                    )}
                    {r.cost > 0 && <span className="cost">${r.cost.toFixed(2)}</span>}
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
                  title={`${theme.label}-Limit verringern`}
                  aria-label={`${theme.label}-Limit verringern`}
                  disabled={r.limit <= 1}
                  onClick={() => setProviderLimit(r.id, r.limit - 1)}
                >
                  −
                </button>
                <span className={`limit-count-val ${over ? 'over' : ''}`} title="aktiv / wartend / Limit">
                  {countLabel}/{r.limit}
                </span>
                <button
                  type="button"
                  title={`${theme.label}-Limit erhöhen`}
                  aria-label={`${theme.label}-Limit erhöhen`}
                  disabled={r.limit >= 16}
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
