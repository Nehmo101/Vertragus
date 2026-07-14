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
import {
  liveOrchestratorTasks,
  ORCHESTRATOR_ACTIVITY_LABEL,
  resolveOrchestratorActivity,
  taskActivityText
} from '@renderer/orchestratorActivity'
import type { OrcaTask, TaskStatus } from '@shared/orchestrator'
import { resolveModel } from '@shared/models'
import { summarizeUsage, summarizeUsageGroup } from '@shared/telemetry'
import { formatTokenCount, formatUsd } from '@renderer/telemetryFormat'

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

/** Compact "12k Token · $0.12" line; null when the provider reported nothing. */
function usageText(usage?: OrcaTask['usage']): string | null {
  const summary = summarizeUsage(usage)
  if (summary.status === 'absent') return null
  const parts: string[] = []
  if (summary.tokens != null) parts.push(`${formatTokenCount(summary.tokens)} Token`)
  if (summary.costUsd != null) parts.push(formatUsd(summary.costUsd))
  if (parts.length === 0 && summary.steps != null) parts.push(`${summary.steps} Schritte`)
  return parts.length > 0 ? parts.join(' · ') : null
}

const TASK_PILL: Record<TaskStatus, { bg: string; fg: string; dot: string; label: string }> = {
  queued: { bg: 'var(--stop-soft)', fg: 'var(--stop-text)', dot: 'var(--stop)', label: 'geplant' },
  running: { bg: 'color-mix(in srgb, var(--run) 18%, transparent)', fg: 'var(--run-text)', dot: 'var(--run)', label: 'läuft' },
  success: { bg: 'color-mix(in srgb, var(--run) 18%, transparent)', fg: 'var(--run-text)', dot: 'var(--run)', label: 'fertig' },
  'needs-work': { bg: 'color-mix(in srgb, #f5a524 18%, transparent)', fg: '#f7c96b', dot: '#f5a524', label: 'Nacharbeit' },
  error: { bg: 'var(--err-soft)', fg: 'var(--err-text)', dot: 'var(--err)', label: 'Fehler' },
  stopped: { bg: 'var(--stop-soft)', fg: 'var(--stop-text)', dot: 'var(--stop)', label: 'gestoppt' }
}

function TaskCard({
  task,
  profileId,
  workspaceSessionId,
  now
}: {
  task: OrcaTask
  profileId: string
  workspaceSessionId?: string
  now: number
}): JSX.Element {
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
  const hasReview = Boolean(
    task.worktree || task.branch || task.commit || task.autoPrStatus || task.remoteCiStatus ||
    task.findings?.length || task.blocker || task.preflight || task.attempts?.length
  )

  const loadDiff = async (): Promise<void> => {
    setDiffLoading(true)
    setDiffError(null)
    try {
      const result = await window.orca.orchestrator.taskDiff(profileId, task.id, workspaceSessionId)
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
          {task.criticality === 'advisory' && <span className="task-criticality">advisory</span>}
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
            {usageText(task.usage) && (
              <div className="task-usage" title="Vom Provider gemeldeter Verbrauch dieses Tasks">
                Verbrauch: {usageText(task.usage)}
              </div>
            )}
          </div>
        )}
        {task.note && (
          <div className={`task-note ${task.status === 'error' || task.status === 'needs-work' ? 'err' : ''}`}>{task.note}</div>
        )}
        {task.findings?.length ? (
          <div className="task-findings" role="status">
            <strong>Gate-Findings</strong>
            {task.findings.map((finding, index) => (
              <div key={`${finding.gate}-${index}`}>
                <span>{finding.gate} · {finding.code}</span>
                <p>{finding.message}</p>
              </div>
            ))}
          </div>
        ) : null}
        {task.blocker && (
          <div className="task-blocker">
            <strong>{task.blocker.code}</strong>
            <span>{task.blocker.summary}</span>
            {task.blocker.details.length > 0 && <small>{task.blocker.details.join(' · ')}</small>}
          </div>
        )}
        {(task.prUrl || task.autoPrStatus || task.remoteCiStatus) && (
          <div className="task-pr-row">
            <span>Auto-PR: {task.autoPrStatus ?? 'unbekannt'}</span>
            {task.remoteCiStatus && (
              <span title={task.remoteCiSummary}>Remote-CI: {task.remoteCiStatus}</span>
            )}
            {task.prUrl && (
              <a href={task.prUrl} target="_blank" rel="noreferrer">
                Pull Request oeffnen
              </a>
            )}
            {task.remoteCiUrl && task.remoteCiUrl !== task.prUrl && (
              <a href={task.remoteCiUrl} target="_blank" rel="noreferrer">
                CI-Check oeffnen
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
              {task.dependsOn?.length ? <><dt>Harte Abhängigkeiten</dt><dd>{task.dependsOn.join(', ')}</dd></> : null}
              {task.advisoryDependsOn?.length ? <><dt>Advisory-Abhängigkeiten</dt><dd>{task.advisoryDependsOn.join(', ')}</dd></> : null}
              {task.conflictKeys?.length ? <><dt>Konfliktbereiche</dt><dd>{task.conflictKeys.join(', ')}</dd></> : null}
              {task.preflight ? <><dt>Preflight</dt><dd>{task.preflight.status === 'passed' ? 'bestanden' : 'fehlgeschlagen'} · {task.preflight.checks.filter((check) => check.status === 'passed').length}/{task.preflight.checks.length} Checks</dd></> : null}
              {task.attempts?.length ? <><dt>Versuche</dt><dd>{task.attempts.map((attempt) => `${attempt.agentName ?? attempt.agentId}: ${attempt.status}`).join(' · ')}</dd></> : null}
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
  const { goal, tasks, pendingPlan, reliability, engineId, lastRetro } = store.orchestrator
  const logRef = useRef<HTMLDivElement>(null)
  const activity = resolveOrchestratorActivity(store.orchestrator, now)
  const liveTasks = liveOrchestratorTasks(tasks)

  const requiredTasks = tasks.filter((task) => (task.criticality ?? 'required') === 'required')
  const done = requiredTasks.filter((task) => task.status === 'success').length
  const pct = requiredTasks.length > 0 ? Math.round((done / requiredTasks.length) * 100) : 0
  const assigned = tasks.filter((t) => t.agentId).length
  const runUsage = summarizeUsageGroup(tasks.map((task) => task.usage))
  const configuredOrchestratorModel = profile?.orchestrator
    ? resolveModel(profile.orchestrator.provider, profile.orchestrator) || 'CLI-Standard'
    : '—'
  const displayedOrchestratorModel = orch?.model || configuredOrchestratorModel

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
          <span className="orch-model">{displayedOrchestratorModel}</span>
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
                /{configuredOrchestratorModel}). Gib ihm im Terminal ein Ziel — er zerlegt es
                und delegiert an Subagents.
              </div>
            </>
          )}
        </div>
        {reliability && (
          <div className="reliability-strip" title={engineId}>
            <span><strong>{reliability.preflightPassed}</strong> Preflights ok</span>
            <span className={reliability.preflightFailed > 0 ? 'warn' : ''}><strong>{reliability.preflightFailed}</strong> blockiert</span>
            <span><strong>{reliability.automaticRecoveries}</strong> Auto-Recoveries</span>
            <span><strong>{reliability.preventedFalseSuccesses}</strong> False-Success verhindert</span>
            <span><strong>{fmtAge(reliability.maxRunningStatusAgeMs)}</strong> max. Statusalter</span>
          </div>
        )}
        {runUsage.status !== 'absent' && (
          <div className="usage-strip" title="Vom Provider gemeldeter Verbrauch aller Tasks dieses Laufs">
            <span>Token gesamt: <strong>{runUsage.tokens != null ? formatTokenCount(runUsage.tokens) : '—'}</strong></span>
            <span>Kosten: <strong>{runUsage.costUsd != null ? formatUsd(runUsage.costUsd) : '—'}</strong></span>
            <span>Schritte: <strong>{runUsage.steps ?? '—'}</strong></span>
          </div>
        )}
        {lastRetro && (
          <details className="retro-card">
            <summary title={lastRetro.goal}>
              <span className="retro-caption">Retro</span> {lastRetro.summary}
            </summary>
            <div className="retro-body">
              {lastRetro.modelStats.map((stat) => (
                <div key={`${stat.provider}/${stat.model}`} className="retro-model">
                  <strong>{stat.provider}/{stat.model || 'Standard'}</strong>
                  <span>
                    {stat.succeeded}/{stat.tasks} ok
                    {stat.needsWork > 0 ? ` · ${stat.needsWork} Nacharbeit` : ''}
                    {stat.failed > 0 ? ` · ${stat.failed} Fehler` : ''}
                    {stat.avgDurationMs != null ? ` · Ø ${fmtAge(stat.avgDurationMs)}` : ''}
                    {stat.tokensIn != null || stat.tokensOut != null
                      ? ` · ${formatTokenCount((stat.tokensIn ?? 0) + (stat.tokensOut ?? 0))} Token`
                      : ''}
                  </span>
                </div>
              ))}
              {lastRetro.learnings.length > 0 && (
                <ul className="retro-learnings">
                  {lastRetro.learnings.slice(0, 6).map((learning) => (
                    <li key={learning.id} title={learning.evidence}>
                      <span className={learning.kind === 'strength' ? 'retro-up' : 'retro-down'}>
                        {learning.kind === 'strength' ? '▲' : '▼'}
                      </span>
                      {learning.provider}/{learning.model || 'Standard'}: {learning.insight}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </details>
        )}
      </div>

      <div className="live-activity">
        <div className="live-activity-caption">
          <span>Live-Lagebericht</span>
          <span>aktualisiert vor {fmtAge(now - activity.updatedAt)}</span>
        </div>
        <div className="coordinator-status">
          <span className="coordinator-mark">ORCH</span>
          <div className="coordinator-status-copy">
            <div className="coordinator-status-head">
              <strong>
                {orch?.name ? <LoreName name={orch.name} /> : 'Orchestrator'}
              </strong>
              <span className={`activity-phase phase-${activity.phase}`}>
                {ORCHESTRATOR_ACTIVITY_LABEL[activity.phase]}
              </span>
            </div>
            <div className="coordinator-summary" role="status" aria-live="polite">{activity.summary}</div>
            {activity.details.length > 0 && (
              <ul className="coordinator-details">
                {activity.details.map((detail, index) => <li key={`${detail}-${index}`}>{detail}</li>)}
              </ul>
            )}
            {activity.nextStep && (
              <div className="coordinator-next"><span>Als Nächstes</span>{activity.nextStep}</div>
            )}
          </div>
        </div>

        <div className="live-workers-head">
          <span>Subagents gerade</span>
          <span>{liveTasks.length} aktiv / wartend</span>
        </div>
        <div className="live-workers">
          {liveTasks.length === 0 ? (
            <div className="live-workers-empty">
              {pendingPlan
                ? 'Noch nicht gestartet — der Plan wartet auf Freigabe.'
                : 'Keine Subagents aktiv. Der Orchestrator plant oder fasst Ergebnisse zusammen.'}
            </div>
          ) : liveTasks.map((task) => {
            const heartbeatAt = task.lastHeartbeatAt ?? task.createdAt
            const heartbeatAge = now - heartbeatAt
            const stale = task.status === 'running' && heartbeatAge > STALE_HEARTBEAT_MS
            return (
              <div key={task.id} className={`live-worker ${stale ? 'stale' : ''}`}>
                <div className="live-worker-head">
                  <strong>
                    {task.agentName ? <LoreName name={task.agentName} /> : task.role}
                  </strong>
                  <span>{task.status === 'queued' ? 'wartet' : stale ? 'ohne neues Signal' : 'arbeitet'}</span>
                </div>
                <div className="live-worker-task">{task.title}</div>
                <div className="live-worker-action" title={task.lastAction}>
                  {taskActivityText(task)}
                </div>
                {task.recentActions && task.recentActions.length > 1 && (
                  <ul className="live-worker-history" title="Vorherige Aktionen dieses Workers">
                    {task.recentActions.slice(1).map((action, index) => (
                      <li key={`${index}-${action}`}>{action}</li>
                    ))}
                  </ul>
                )}
                <div className="live-worker-meta">
                  <span>{task.role}{task.model ? ` · ${task.model}` : ''}</span>
                  <span>
                    {task.status === 'queued'
                      ? `wartet seit ${fmtAge(now - task.createdAt)}`
                      : `Update vor ${fmtAge(heartbeatAge)}`}
                  </span>
                </div>
                {usageText(task.usage) && (
                  <div className="live-worker-usage" title="Vom Provider gemeldeter Verbrauch dieses Tasks">
                    {usageText(task.usage)}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </div>

      <div className="orch-panel-body">
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
              <button type="button" className="btn ghost" onClick={() => void window.orca.orchestrator.reviewPlan(store.activeProfileId, false, store.activeWorkspaceSessionId ?? undefined)}>
                Ablehnen
              </button>
              <button type="button" className="btn primary" onClick={() => void window.orca.orchestrator.reviewPlan(store.activeProfileId, true, store.activeWorkspaceSessionId ?? undefined)}>
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
              <TaskCard
                key={task.id}
                task={task}
                profileId={store.activeProfileId}
                workspaceSessionId={store.activeWorkspaceSessionId ?? undefined}
                now={now}
              />
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
