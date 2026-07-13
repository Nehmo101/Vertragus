import { useEffect, useRef, useState } from 'react'
import {
  useAppStore,
  activeProfile,
  workspaceAgents,
  workspaceEvents
} from '@renderer/store/useAppStore'
import { PROVIDER_THEME } from '@renderer/ui/theme'
import LoreName from '@renderer/components/LoreName'
import LimitsPanel from '@renderer/components/LimitsPanel'
import type { OrcaTask, TaskStatus } from '@shared/orchestrator'

const STALE_HEARTBEAT_MS = 90_000

type TaskWithTelemetry = OrcaTask & {
  lastHeartbeatAt?: number
  phase?: string
  lastAction?: string
}

function useClock(): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])
  return now
}

function fmtTime(ts: number): string {
  return new Date(ts).toTimeString().slice(0, 8)
}

function fmtAge(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

const TASK_PILL: Record<TaskStatus, { bg: string; fg: string; dot: string; label: string }> = {
  queued: { bg: 'var(--stop-soft)', fg: 'var(--stop-text)', dot: 'var(--stop)', label: 'geplant' },
  running: { bg: 'color-mix(in srgb, var(--run) 18%, transparent)', fg: 'var(--run-text)', dot: 'var(--run)', label: 'läuft' },
  success: { bg: 'color-mix(in srgb, var(--run) 18%, transparent)', fg: 'var(--run-text)', dot: 'var(--run)', label: 'fertig' },
  error: { bg: 'var(--err-soft)', fg: 'var(--err-text)', dot: 'var(--err)', label: 'Fehler' },
  stopped: { bg: 'var(--stop-soft)', fg: 'var(--stop-text)', dot: 'var(--stop)', label: 'gestoppt' }
}

function TaskCard({ task, profileId, now }: { task: OrcaTask; profileId: string; now: number }): JSX.Element {
  const [diff, setDiff] = useState<string | null>(null)
  const [diffError, setDiffError] = useState<string | null>(null)
  const [diffLoading, setDiffLoading] = useState(false)
  const telemetry = task as TaskWithTelemetry
  const pill = TASK_PILL[task.status]
  const chip = task.provider ? PROVIDER_THEME[task.provider] : undefined
  const heartbeatBase = telemetry.lastHeartbeatAt ?? task.createdAt
  const heartbeatAge = now - heartbeatBase
  const heartbeatMissing = task.status === 'running' && telemetry.lastHeartbeatAt == null
  const heartbeatStale = task.status === 'running' && heartbeatAge > STALE_HEARTBEAT_MS
  const showTelemetry = task.status === 'running' || Boolean(telemetry.phase || telemetry.lastAction)
  const label = task.status === 'running' && task.yolo ? 'läuft · yolo' : pill.label
  const hasReview = Boolean(task.worktree || task.branch || task.commit || task.autoPrStatus)

  const loadDiff = async (): Promise<void> => {
    setDiffLoading(true)
    setDiffError(null)
    try {
      const result = await window.orca.orchestrator.taskDiff(profileId, task.id)
      setDiff(result.diff)
    } catch (error) {
      setDiffError(error instanceof Error ? error.message : String(error))
    } finally {
      setDiffLoading(false)
    }
  }
  return (
    <div className="dag-item">
      <div className="dag-rail">
        <span
          className="dag-node"
          style={{ background: pill.dot, boxShadow: `0 0 7px ${pill.dot}` }}
        />
        <span className="dag-line" />
      </div>
      <div className={`task-card ${heartbeatStale ? 'heartbeat-stale' : ''}`}>
        <div className="task-row1">
          <span
            className="task-dot"
            style={{ background: pill.dot, boxShadow: `0 0 6px ${pill.dot}` }}
          />
          <span className="task-title">{task.title}</span>
          <span className="task-id">{task.id}</span>
        </div>
        <div className="task-row2">
          <span className="assignee">
            <span
              className="assignee-dot"
              style={{ background: chip?.fg ?? 'var(--stop)' }}
            />
            {task.agentName ? (
              <>
                <LoreName name={task.agentName} className="assignee-name" />
                {` · ${task.role}`}
              </>
            ) : (
              task.role
            )}
            {task.model ? ` · ${task.model}` : ''}
          </span>
          <span className="spacer" />
          <span className="task-pill" style={{ background: pill.bg, color: pill.fg }}>
            {label}
          </span>
        </div>
        {task.status === 'running' && (
          <div className="task-bar">
            <div
              className={`task-bar-fill ${task.progress == null ? 'indeterminate' : ''}`}
              style={
                task.progress == null
                  ? undefined
                  : { width: `${Math.min(100, Math.max(0, task.progress))}%` }
              }
            />
          </div>
        )}
        {showTelemetry && (
          <div className={`task-telemetry ${heartbeatStale ? 'stale' : ''}`}>
            <div className="task-telemetry-row">
              <span className="task-phase">{telemetry.phase?.trim() || 'In Arbeit'}</span>
              {task.progress != null && <span>{Math.round(task.progress)}%</span>}
              {task.status === 'running' && (
                <span
                  className="task-heartbeat"
                  title={
                    telemetry.lastHeartbeatAt
                      ? `Letzter Heartbeat: ${new Date(telemetry.lastHeartbeatAt).toLocaleString()}`
                      : 'Noch kein expliziter Heartbeat empfangen'
                  }
                >
                  <span className="heartbeat-dot" />
                  {heartbeatStale
                    ? `Heartbeat veraltet · ${fmtAge(heartbeatAge)}`
                    : heartbeatMissing
                      ? `Heartbeat ausstehend · ${fmtAge(heartbeatAge)}`
                      : `Heartbeat · vor ${fmtAge(heartbeatAge)}`}
                </span>
              )}
            </div>
            {telemetry.lastAction?.trim() && (
              <div className="task-last-action" title={telemetry.lastAction}>
                Zuletzt: {telemetry.lastAction}
              </div>
            )}
          </div>
        )}
        {task.note && (
          <div className={`task-note ${task.status === 'error' ? 'err' : ''}`}>{task.note}</div>
        )}
        {(task.prUrl || task.autoPrStatus) && (
          <div className="task-pr-row">
            <span>Auto-PR: {task.autoPrStatus ?? 'unbekannt'}</span>
            {task.prUrl && (
              <a href={task.prUrl} target="_blank" rel="noreferrer">
                Pull Request oeffnen
              </a>
            )}
          </div>
        )}
        {hasReview && (
          <details className="task-review">
            <summary>Review-Details</summary>
            <dl>
              {task.branch && <><dt>Branch</dt><dd><code>{task.branch}</code></dd></>}
              {task.commit && <><dt>Commit</dt><dd><code>{task.commit}</code></dd></>}
              {task.worktree && <><dt>Worktree</dt><dd title={task.worktree}>{task.worktree}</dd></>}
              {task.dependsOn?.length ? <><dt>Abhängig von</dt><dd>{task.dependsOn.join(', ')}</dd></> : null}
              {task.conflictKeys?.length ? <><dt>Konfliktbereiche</dt><dd>{task.conflictKeys.join(', ')}</dd></> : null}
            </dl>
            {task.worktree && (
              <button
                type="button"
                className="btn ghost task-diff-btn"
                disabled={diffLoading}
                onClick={() => void loadDiff()}
              >
                {diffLoading ? 'Diff wird geladen…' : diff ? 'Diff aktualisieren' : 'Git-Diff anzeigen'}
              </button>
            )}
            {diffError && <div className="task-note err">{diffError}</div>}
            {diff && <pre className="task-diff">{diff}</pre>}
          </details>
        )}
      </div>
    </div>
  )
}

export default function OrchestratorPanel(): JSX.Element {
  const store = useAppStore()
  const now = useClock()
  const profile = activeProfile(store)
  const orch = workspaceAgents(store).find((agent) => agent.kind === 'orchestrator')
  const events = workspaceEvents(store)
  const { goal, tasks, pendingPlan } = store.orchestrator
  const logRef = useRef<HTMLDivElement>(null)

  const done = tasks.filter((t) => t.status === 'success').length
  const pct = tasks.length > 0 ? Math.round((done / tasks.length) * 100) : 0
  const assigned = tasks.filter((t) => t.agentId).length

  useEffect(() => {
    const el = logRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [events.length])

  return (
    <section className="orch-panel">
      <LimitsPanel />
      <div className="orch-head">
        <div className="orch-head-row">
          <span className="orch-diamond">◇</span>
          <span className="orch-title">Orchestrator</span>
          <span className="orch-model">{orch?.model ?? profile?.orchestrator?.model ?? '—'}</span>
          <div className="spacer" />
          <span className="mini-toggle-label">{goal?.active ? 'aktiv' : 'inaktiv'}</span>
          <span className={`mini-toggle ${goal?.active ? '' : 'off'}`}>
            <span className="knob" />
          </span>
        </div>

        <div className="goal-card">
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span className="goal-caption">Aktuelles Ziel</span>
            <span className="goal-id">{goal?.id ?? '—'}</span>
          </div>
          {goal ? (
            <>
              <div className="goal-title">{goal.title}</div>
              <div className="goal-bar">
                <div className="goal-bar-fill" style={{ width: `${pct}%` }} />
              </div>
              <div className="goal-stats">
                <span>
                  {tasks.length} Subtasks · {assigned} zugewiesen
                </span>
                <span className="pct">{pct}%</span>
              </div>
            </>
          ) : (
            <>
              <div className="goal-title">Kein aktives Ziel</div>
              <div className="goal-note">
                „▶ Alle starten" aktiviert den Orchestrator ({profile?.orchestrator?.provider ?? '—'}
                /{profile?.orchestrator?.model ?? '—'}). Gib ihm im Terminal ein Ziel — er zerlegt es
                und delegiert an Subagents.
              </div>
            </>
          )}
        </div>
      </div>

      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        <div className="dag-caption">
          <span>Aufgaben-Zerlegung</span>
          <span className="tag">DAG</span>
        </div>
        {pendingPlan && (
          <div className="plan-review" role="status" aria-live="polite">
            <div className="plan-review-head">
              <div>
                <strong>Plan wartet auf Freigabe</strong>
                <span>
                  {pendingPlan.plan.tasks.length} Aufgaben, maximal{' '}
                  {pendingPlan.plan.maxParallel} parallel
                </span>
              </div>
              <code>{pendingPlan.planId}</code>
            </div>
            <ol>
              {pendingPlan.plan.tasks.map((task) => (
                <li key={task.id}>
                  <strong>{task.title}</strong>
                  <span>{task.role}</span>
                </li>
              ))}
            </ol>
            {pendingPlan.validationIssues.length > 0 && (
              <div className="plan-review-warning">
                Der Vorschlag wurde sicher normalisiert. Bitte vor dem Start pruefen.
              </div>
            )}
            <div className="plan-review-actions">
              <button type="button" className="btn ghost" onClick={() => void window.orca.orchestrator.reviewPlan(store.activeProfileId, false)}>
                Ablehnen
              </button>
              <button type="button" className="btn primary" onClick={() => void window.orca.orchestrator.reviewPlan(store.activeProfileId, true)}>
                Plan starten
              </button>
            </div>
          </div>
        )}
        <div className="dag-scroll">
          {tasks.length === 0 ? (
            <div className="dag-empty">
              Noch keine Aufgaben. Sobald der Orchestrator <code>dispatch_subagent</code> aufruft,
              erscheinen hier die Teilaufgaben live — jede läuft als echter Subagent im Grid.
            </div>
          ) : (
            tasks.map((task) => (
              <TaskCard key={task.id} task={task} profileId={store.activeProfileId} now={now} />
            ))
          )}
        </div>

        <div className="dispatch">
          <div className="dispatch-head">
            <span className="caption">Dispatch-Protokoll</span>
            <span className="dot" />
            <div className="spacer" />
            <span className="clock">{fmtTime(now)}</span>
          </div>
          <div className="dispatch-body" ref={logRef}>
            {events.length === 0 && (
              <div className="dispatch-line tone-muted">— bereit —</div>
            )}
            {events.map((evt, i) => (
              <div key={i} className={`dispatch-line tone-${evt.tone}`}>
                <span className="time">{fmtTime(evt.time)}</span> {evt.text}
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  )
}
