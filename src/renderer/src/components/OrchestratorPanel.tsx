import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import {
  useAppStore,
  activeProfile,
  workspaceAgents,
  workspaceEvents
} from '@renderer/store/useAppStore'
import { PROVIDER_THEME } from '@renderer/ui/theme'
import LoreName from '@renderer/components/LoreName'
import LimitsPanel from '@renderer/components/LimitsPanel'
import InfoTip from '@renderer/components/InfoTip'
import { collectEligibleSources } from '@renderer/components/HandoffModal'
import {
  liveOrchestratorTasks,
  ORCHESTRATOR_ACTIVITY_LABEL,
  resolveOrchestratorActivity,
  taskActivityText
} from '@renderer/orchestratorActivity'
import type { VertragusTask, TaskStatus } from '@shared/orchestrator'
import { resolveModel } from '@shared/models'
import type { AgentUsage, AgentInstanceInfo } from '@shared/agents'
import { summarizeUsage, summarizeUsageGroup, TELEMETRY_STATUS_LABELS, TELEMETRY_STATUS_TITLES } from '@shared/telemetry'
import { formatTokenBreakdown, formatTokenCount, formatUsd } from '@renderer/telemetryFormat'
import { ResizeHandle } from '@renderer/components/ResizeHandle'
import { selectPanelLayout, useLayoutStore } from '@renderer/store/layoutStore'

const STALE_HEARTBEAT_MS = 90_000
const MAX_VISIBLE_FINDINGS = 6

type PlannerMode = 'auto' | 'review' | 'manual'
const PLANNER_MODES: PlannerMode[] = ['auto', 'review', 'manual']

type TaskWithTelemetry = VertragusTask & {
  lastHeartbeatAt?: number
  phase?: string
  lastAction?: string
}

// Ticks once per second only while there is active work to time (running/waiting
// agents). When idle the interval is torn down, so the panel no longer re-renders
// every second just to advance clocks nobody is watching.
function useClock(active: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [active])
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
function usageText(t: TFunction, usage?: VertragusTask['usage']): string | null {
  const summary = summarizeUsage(usage)
  if (summary.status === 'absent') return null
  const parts: string[] = []
  if (summary.tokens != null)
    parts.push(t('orch.usage.tokens', { value: formatTokenCount(summary.tokens) }))
  if (summary.costUsd != null) parts.push(formatUsd(summary.costUsd))
  if (parts.length === 0 && summary.steps != null)
    parts.push(t('orch.usage.steps', { value: summary.steps }))
  return parts.length > 0 ? parts.join(' · ') : null
}

const TASK_PILL: Record<TaskStatus, { bg: string; fg: string; dot: string }> = {
  queued: { bg: 'var(--stop-soft)', fg: 'var(--stop-text)', dot: 'var(--stop)' },
  paused: { bg: 'color-mix(in srgb, #f5a524 18%, transparent)', fg: '#f7c96b', dot: '#f5a524' },
  waiting: { bg: 'color-mix(in srgb, #f5a524 18%, transparent)', fg: '#f7c96b', dot: '#f5a524' },
  running: { bg: 'color-mix(in srgb, var(--run) 18%, transparent)', fg: 'var(--run-text)', dot: 'var(--run)' },
  success: { bg: 'color-mix(in srgb, var(--run) 18%, transparent)', fg: 'var(--run-text)', dot: 'var(--run)' },
  'needs-work': { bg: 'color-mix(in srgb, #f5a524 18%, transparent)', fg: '#f7c96b', dot: '#f5a524' },
  error: { bg: 'var(--err-soft)', fg: 'var(--err-text)', dot: 'var(--err)' },
  stopped: { bg: 'var(--stop-soft)', fg: 'var(--stop-text)', dot: 'var(--stop)' }
}

function TaskCard({
  task,
  usage,
  profileId,
  workspaceSessionId,
  now
}: {
  task: VertragusTask
  usage?: AgentUsage
  profileId: string
  workspaceSessionId?: string
  now: number
}): JSX.Element {
  const { t } = useTranslation()
  const [diff, setDiff] = useState<string | null>(null)
  const [diffError, setDiffError] = useState<string | null>(null)
  const [diffLoading, setDiffLoading] = useState(false)
  const telemetry = task as TaskWithTelemetry
  const pill = TASK_PILL[task.status]
  const worker = summarizeUsage(usage)
  const chip = task.provider ? PROVIDER_THEME[task.provider] : undefined
  const heartbeatBase = telemetry.lastHeartbeatAt ?? task.createdAt
  const heartbeatAge = now - heartbeatBase
  const heartbeatMissing = task.status === 'running' && telemetry.lastHeartbeatAt == null
  const heartbeatStale = task.status === 'running' && heartbeatAge > STALE_HEARTBEAT_MS
  const showTelemetry = task.status === 'running' || Boolean(telemetry.phase || telemetry.lastAction)
  const label =
    task.status === 'running' && task.yolo
      ? t('orch.task.runningYolo')
      : task.interrupted
        ? t('orch.status.interrupted')
        : t(`orch.status.${task.status}`)
  const hasReview = Boolean(
    task.worktree || task.branch || task.commit || task.autoPrStatus || task.remoteCiStatus ||
    task.findings?.length || task.blocker || task.preflight || task.attempts?.length
  )

  const loadDiff = async (): Promise<void> => {
    setDiffLoading(true)
    setDiffError(null)
    try {
      const result = await window.vertragus.orchestrator.taskDiff(profileId, task.id, workspaceSessionId)
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
          {task.criticality === 'advisory' && (
            <span className="task-criticality">{t('orch.task.advisory')}</span>
          )}
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
          {task.interrupted && (
            <button
              type="button"
              className="btn ghost task-resume-btn"
              title={t('orch.task.resumeInterruptedHint')}
              onClick={() =>
                void window.vertragus.orchestrator.resumeInterruptedTask(
                  profileId,
                  workspaceSessionId ?? '',
                  task.id
                )
              }
            >
              ▶ {t('orch.task.resumeInterrupted')}
            </button>
          )}
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
              <span className="task-phase">{telemetry.phase?.trim() || t('orch.task.inProgress')}</span>
              {task.progress != null && <span>{Math.round(task.progress)}%</span>}
              {task.status === 'running' && (
                <span
                  className="task-heartbeat"
                  title={
                    telemetry.lastHeartbeatAt
                      ? t('orch.task.lastHeartbeat', {
                          time: new Date(telemetry.lastHeartbeatAt).toLocaleString()
                        })
                      : t('orch.task.noHeartbeat')
                  }
                >
                  <span className="heartbeat-dot" />
                  {heartbeatStale
                    ? t('orch.task.heartbeatStale', { age: fmtAge(heartbeatAge) })
                    : heartbeatMissing
                      ? t('orch.task.heartbeatPending', { age: fmtAge(heartbeatAge) })
                      : t('orch.task.heartbeatAgo', { age: fmtAge(heartbeatAge) })}
                </span>
              )}
            </div>
            {telemetry.lastAction?.trim() && (
              <div className="task-last-action" title={telemetry.lastAction}>
                {t('orch.task.lastAction', { action: telemetry.lastAction })}
              </div>
            )}
            {usageText(t, task.usage) && (
              <div className="task-usage" title={t('orch.task.usageTitle')}>
                {t('orch.task.usage', { value: usageText(t, task.usage) })}
              </div>
            )}
          </div>
        )}
        {usage && worker.status !== 'absent' && (
          <div className="task-usage" title={t('orch.task.subagentTelemetry')}>
            {worker.steps != null && (
              <span><span className="k">{t('orch.usageLabels.steps')}</span> <b>{worker.steps}</b></span>
            )}
            {worker.tokens != null && (
              <span title={formatTokenBreakdown(usage.tokensIn, usage.tokensOut)}>
                <span className="k">{t('orch.usageLabels.tokens')}</span> <b>{formatTokenCount(worker.tokens)}</b>
              </span>
            )}
            {worker.costUsd != null && (
              <span><span className="k">{t('orch.usageLabels.cost')}</span> <b className="cost">{formatUsd(worker.costUsd)}</b></span>
            )}
            {worker.status === 'partial' && (
              <span className="telemetry-status partial" title={TELEMETRY_STATUS_TITLES.partial}>
                {TELEMETRY_STATUS_LABELS.partial}
              </span>
            )}
          </div>
        )}
        {task.note && (
          <div className={`task-note ${task.status === 'error' || task.status === 'needs-work' ? 'err' : ''}`}>{task.note}</div>
        )}
        {task.findings?.length ? (
          <div className="task-findings" role="status">
            <strong>{t('orch.task.gateFindings')}</strong>
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
            <span>{t('orch.task.autoPr', { status: task.autoPrStatus ?? t('orch.task.unknown') })}</span>
            {task.remoteCiStatus && (
              <span title={task.remoteCiSummary}>{t('orch.task.remoteCi', { status: task.remoteCiStatus })}</span>
            )}
            {task.prUrl && (
              <a href={task.prUrl} target="_blank" rel="noreferrer">
                {t('orch.task.openPr')}
              </a>
            )}
            {task.remoteCiUrl && task.remoteCiUrl !== task.prUrl && (
              <a href={task.remoteCiUrl} target="_blank" rel="noreferrer">
                {t('orch.task.openCi')}
              </a>
            )}
          </div>
        )}
        {hasReview && (
          <details className="task-review">
            <summary>{t('orch.task.reviewDetails')}</summary>
            <dl>
              {task.branch && <><dt>{t('orch.task.branch')}</dt><dd><code>{task.branch}</code></dd></>}
              {task.commit && <><dt>{t('orch.task.commit')}</dt><dd><code>{task.commit}</code></dd></>}
              {task.worktree && <><dt>{t('orch.task.worktree')}</dt><dd title={task.worktree}>{task.worktree}</dd></>}
              {task.dependsOn?.length ? <><dt>{t('orch.task.hardDeps')}</dt><dd>{task.dependsOn.join(', ')}</dd></> : null}
              {task.advisoryDependsOn?.length ? <><dt>{t('orch.task.advisoryDeps')}</dt><dd>{task.advisoryDependsOn.join(', ')}</dd></> : null}
              {task.conflictKeys?.length ? <><dt>{t('orch.task.conflictKeys')}</dt><dd>{task.conflictKeys.join(', ')}</dd></> : null}
              {task.preflight ? <><dt>{t('orch.task.preflight')}</dt><dd>{task.preflight.status === 'passed' ? t('orch.task.passed') : t('orch.task.failed')} · {t('orch.task.checks', { passed: task.preflight.checks.filter((check) => check.status === 'passed').length, total: task.preflight.checks.length })}</dd></> : null}
              {task.attempts?.length ? <><dt>{t('orch.task.attempts')}</dt><dd>{task.attempts.map((attempt) => `${attempt.agentName ?? attempt.agentId}: ${attempt.status}`).join(' · ')}</dd></> : null}
            </dl>
            {task.worktree && (
              <button
                type="button"
                className="btn ghost task-diff-btn"
                disabled={diffLoading}
                onClick={() => void loadDiff()}
              >
                {diffLoading
                  ? t('orch.task.diffLoading')
                  : diff
                    ? t('orch.task.diffRefresh')
                    : t('orch.task.diffShow')}
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

function OrchestratorPanelContent({
  width,
  onCollapse
}: {
  width: number
  onCollapse: () => void
}): JSX.Element {
  const { t } = useTranslation()
  const store = useAppStore()
  const [autoModeBusy, setAutoModeBusy] = useState(false)
  const hasActiveWork = store.agents.some(
    (agent) => agent.status === 'running' || agent.status === 'waiting'
  )
  const now = useClock(hasActiveWork)
  const profile = activeProfile(store)
  const wsAgents = workspaceAgents(store)
  const orch = wsAgents.find((agent) => agent.kind === 'orchestrator')
  const usageByAgentId = new Map(wsAgents.map((agent) => [agent.id, agent.usage] as const))
  const events = workspaceEvents(store)
  const { goal, tasks, pendingPlan, plannerMode, reliability, engineId, lastRetro, findings } =
    store.orchestrator
  // The engine appends board entries in order; the panel shows the newest first.
  const boardFindings = [...(findings ?? [])].reverse()
  const logRef = useRef<HTMLDivElement>(null)
  const activity = resolveOrchestratorActivity(store.orchestrator, now)
  const liveTasks = liveOrchestratorTasks(tasks)

  const requiredTasks = tasks.filter((task) => (task.criticality ?? 'required') === 'required')
  const done = requiredTasks.filter((task) => task.status === 'success').length
  const pct = requiredTasks.length > 0 ? Math.round((done / requiredTasks.length) * 100) : 0
  const assigned = tasks.filter((t) => t.agentId).length
  const runUsage = summarizeUsageGroup(tasks.map((task) => task.usage))
  const configuredOrchestratorModel = profile?.orchestrator
    ? resolveModel(profile.orchestrator.provider, profile.orchestrator) || t('orch.cliDefault')
    : '—'
  const displayedOrchestratorModel = orch?.model || configuredOrchestratorModel

  useEffect(() => {
    const el = logRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [events.length])
  const currentPlannerMode: PlannerMode =
    (plannerMode ?? profile?.planner.mode ?? 'review') as PlannerMode
  const autoModeActive = currentPlannerMode === 'auto'
  const changePlannerMode = async (mode: PlannerMode): Promise<void> => {
    if (autoModeBusy || mode === currentPlannerMode || !store.activeWorkspaceSessionId) return
    const startsPendingPlan = mode === 'auto' && Boolean(pendingPlan)
    setAutoModeBusy(true)
    try {
      const ok = await window.vertragus.orchestrator.setPlannerMode(
        store.activeProfileId,
        mode,
        store.activeWorkspaceSessionId
      )
      if (!ok) throw new Error(t('orch.plannerMode.switchFailed'))
      store.showToast(
        mode === 'auto'
          ? startsPendingPlan
            ? t('orch.plannerMode.toastAutoPending')
            : t('orch.plannerMode.toastAuto')
          : mode === 'review'
            ? t('orch.plannerMode.toastReview')
            : t('orch.plannerMode.toastManual')
      )
    } catch (error) {
      store.showToast(error instanceof Error ? error.message : String(error))
    } finally {
      setAutoModeBusy(false)
    }
  }

  // "Massenübergabe": target the largest cohort of running interactive agents that
  // share a provider — the same cohort the handoff modal would bulk-transfer.
  const bulkHandoffTarget = ((): { agent: AgentInstanceInfo; count: number } | null => {
    const candidates = wsAgents.filter(
      (agent) => agent.mode === 'interactive' && agent.status === 'running' && !agent.handoffTo
    )
    let best: { agent: AgentInstanceInfo; count: number } | null = null
    for (const agent of candidates) {
      const count = collectEligibleSources(agent, store.agents).length
      if (!best || count > best.count) best = { agent, count }
    }
    return best && best.count >= 2 ? best : null
  })()

  // Rendered near the top of the panel so an awaiting plan approval is impossible to miss.
  const planReview = pendingPlan ? (
    <div className="plan-review plan-review-top" role="status" aria-live="polite">
      <div className="plan-review-head">
        <div>
          <strong>{t('orch.plan.waiting')}</strong>
          <span>
            {t('orch.plan.stats', {
              tasks: pendingPlan.plan.tasks.length,
              parallel: pendingPlan.plan.maxParallel
            })}
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
          <strong>
            {pendingPlan.rejected
              ? t('orch.plan.rejectedWarning')
              : t('orch.plan.normalizedWarning')}
          </strong>
          <div role="list">
            {pendingPlan.validationIssues.map((issue, index) => (
              <div role="listitem" key={`${issue.code}-${issue.taskId ?? index}`}>
                <code>{issue.code}</code>{issue.taskId ? ` · ${issue.taskId}` : ''}: {issue.message}
              </div>
            ))}
          </div>
        </div>
      )}
      <div className="plan-review-actions">
        <button type="button" className="btn ghost" onClick={() => void store.reviewPendingPlan(false)}>
          {t('orch.plan.reject')}
        </button>
        <button type="button" className="btn primary" onClick={() => void store.reviewPendingPlan(true)}>
          {pendingPlan.rejected ? t('orch.plan.startFallback') : t('orch.plan.start')}
        </button>
      </div>
    </div>
  ) : null

  return (
    <section
      id="orchestrator-right-panel"
      className="orch-panel layout-panel"
      style={{ width }}
      aria-label={t('orch.panelAria')}
    >
      <div className="panel-control-row panel-control-row-right">
        <button
          type="button"
          className="panel-collapse-button"
          aria-controls="orchestrator-right-content"
          aria-expanded="true"
          aria-label={t('orch.collapse')}
          title={t('orch.collapse')}
          onClick={onCollapse}
        >
          ›
        </button>
      </div>
      <div id="orchestrator-right-content" className="panel-scroll-content">
      <LimitsPanel />
      {bulkHandoffTarget && (
        <div className="bulk-handoff-bar">
          <button
            type="button"
            className="btn ghost bulk-handoff-btn"
            title={t('orch.bulkHandoffHint', { n: bulkHandoffTarget.count })}
            onClick={() => store.openHandoff(bulkHandoffTarget.agent.id, { bulk: true })}
          >
            ⇄ {t('orch.bulkHandoff', { n: bulkHandoffTarget.count })}
          </button>
        </div>
      )}
      {planReview}
      <div className="orch-head">
        <div className="orch-head-row">
          <span className="orch-diamond">◇</span>
          <span className="orch-title">{t('orch.title')}</span>
          <span className="orch-model">{displayedOrchestratorModel}</span>
          <div className="spacer" />
          <span className="mini-toggle-label">
            {goal?.active ? t('orch.active') : t('orch.inactive')}{' '}
            <InfoTip text={t('orch.goalActiveHelp')} />
          </span>
          <span
            className={`mini-toggle status ${goal?.active ? '' : 'off'}`}
            role="img"
            aria-label={goal?.active ? t('orch.goalActiveAria') : t('orch.goalInactiveAria')}
            title={t('orch.goalActiveHelp')}
          >
            <span className="knob" />
          </span>
        </div>
        {orch && store.activeWorkspaceSessionId && (
          <div className={`planner-mode-control ${autoModeActive ? 'auto' : ''}`}>
            <div className="planner-mode-copy">
              <span>{t('orch.plannerMode.caption')} <InfoTip text={t('orch.plannerMode.help')} /></span>
              <strong>{t(`orch.plannerMode.desc.${currentPlannerMode}`)}</strong>
            </div>
            <div className="planner-mode-switch" role="group" aria-label={t('orch.plannerMode.choose')}>
              {PLANNER_MODES.map((mode) => (
                <button
                  key={mode}
                  type="button"
                  className={`planner-mode-opt ${currentPlannerMode === mode ? 'active' : ''}`}
                  aria-pressed={currentPlannerMode === mode}
                  disabled={autoModeBusy || currentPlannerMode === mode}
                  title={t(`orch.plannerMode.title.${mode}`)}
                  onClick={() => void changePlannerMode(mode)}
                >
                  {t(`orch.plannerMode.label.${mode}`)}
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="goal-card">
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span className="goal-caption">{t('orch.goal.caption')}</span>
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
                  {t('orch.goal.stats', { total: tasks.length, assigned })}
                </span>
                <span className="pct">{pct}%</span>
              </div>
            </>
          ) : (
            <>
              <div className="goal-title">{t('orch.goal.none')}</div>
              <div className="goal-note">
                {t('orch.goal.note', {
                  provider: profile?.orchestrator?.provider ?? '—',
                  model: configuredOrchestratorModel
                })}
              </div>
            </>
          )}
        </div>
        {reliability && (
          <div className="reliability-strip" title={engineId}>
            <span><strong>{reliability.preflightPassed}</strong> {t('orch.reliability.preflightOk')}</span>
            <span className={reliability.preflightFailed > 0 ? 'warn' : ''}><strong>{reliability.preflightFailed}</strong> {t('orch.reliability.blocked')}</span>
            <span><strong>{reliability.automaticRecoveries}</strong> {t('orch.reliability.autoRecoveries')}</span>
            <span><strong>{reliability.preventedFalseSuccesses}</strong> {t('orch.reliability.falseSuccess')}</span>
            <span><strong>{fmtAge(reliability.maxRunningStatusAgeMs)}</strong> {t('orch.reliability.maxStatusAge')}</span>
          </div>
        )}
        {runUsage.status !== 'absent' && (
          <div className="usage-strip" title={t('orch.run.usageTitle')}>
            <span>{t('orch.run.tokens')}: <strong>{runUsage.tokens != null ? formatTokenCount(runUsage.tokens) : '—'}</strong></span>
            <span>{t('orch.run.cost')}: <strong>{runUsage.costUsd != null ? formatUsd(runUsage.costUsd) : '—'}</strong></span>
            <span>{t('orch.run.steps')}: <strong>{runUsage.steps ?? '—'}</strong></span>
          </div>
        )}
        {lastRetro && (
          <details className="retro-card">
            <summary title={lastRetro.goal}>
              <span className="retro-caption">{t('orch.retro.caption')}</span> {lastRetro.summary}
            </summary>
            <div className="retro-body">
              {lastRetro.modelStats.map((stat) => (
                <div key={`${stat.provider}/${stat.model}`} className="retro-model">
                  <strong>{stat.provider}/{stat.model || t('orch.retro.default')}</strong>
                  <span>
                    {t('orch.retro.ok', { succeeded: stat.succeeded, total: stat.tasks })}
                    {stat.needsWork > 0 ? ` · ${t('orch.retro.needsWork', { n: stat.needsWork })}` : ''}
                    {stat.failed > 0 ? ` · ${t('orch.retro.failed', { n: stat.failed })}` : ''}
                    {stat.avgDurationMs != null ? ` · ${t('orch.retro.avg', { value: fmtAge(stat.avgDurationMs) })}` : ''}
                    {stat.tokensIn != null || stat.tokensOut != null
                      ? ` · ${t('orch.usage.tokens', { value: formatTokenCount((stat.tokensIn ?? 0) + (stat.tokensOut ?? 0)) })}`
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
                      {learning.provider}/{learning.model || t('orch.retro.default')}: {learning.insight}
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
          <span>{t('orch.live.caption')}</span>
          <span>{t('orch.live.updated', { age: fmtAge(now - activity.updatedAt) })}</span>
        </div>
        <div className="coordinator-status">
          <span className="coordinator-mark">ORCH</span>
          <div className="coordinator-status-copy">
            <div className="coordinator-status-head">
              <strong>
                {orch?.name ? <LoreName name={orch.name} /> : t('orch.title')}
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
              <div className="coordinator-next"><span>{t('orch.live.nextStep')}</span>{activity.nextStep}</div>
            )}
          </div>
        </div>

        <div className="live-workers-head">
          <span>{t('orch.live.subagents')}</span>
          <span>{t('orch.live.activeWaiting', { n: liveTasks.length })}</span>
        </div>
        <div className="live-workers">
          {liveTasks.length === 0 ? (
            <div className="live-workers-empty">
              {pendingPlan ? t('orch.live.notStarted') : t('orch.live.empty')}
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
                  <span>
                    {task.status === 'queued'
                      ? t('orch.live.waiting')
                      : stale
                        ? t('orch.live.noSignal')
                        : t('orch.live.working')}
                  </span>
                </div>
                <div className="live-worker-task">{task.title}</div>
                <div className="live-worker-action" title={task.lastAction}>
                  {taskActivityText(task)}
                </div>
                {task.recentActions && task.recentActions.length > 1 && (
                  <ul className="live-worker-history" title={t('orch.live.historyTitle')}>
                    {task.recentActions.slice(1).map((action, index) => (
                      <li key={`${index}-${action}`}>{action}</li>
                    ))}
                  </ul>
                )}
                <div className="live-worker-meta">
                  <span>{task.role}{task.model ? ` · ${task.model}` : ''}</span>
                  <span>
                    {task.status === 'queued'
                      ? t('orch.live.waitingSince', { age: fmtAge(now - task.createdAt) })
                      : t('orch.live.updateAgo', { age: fmtAge(heartbeatAge) })}
                  </span>
                </div>
                {usageText(t, task.usage) && (
                  <div className="live-worker-usage" title={t('orch.task.usageTitle')}>
                    {usageText(t, task.usage)}
                  </div>
                )}
              </div>
            )
          })}
        </div>

        {boardFindings.length > 0 && (
          <>
            <div className="live-workers-head findings-board-head">
              <span>{t('orch.findings.caption')}</span>
              <span>
                {boardFindings.length > MAX_VISIBLE_FINDINGS
                  ? t('orch.findings.showing', { shown: MAX_VISIBLE_FINDINGS, total: boardFindings.length })
                  : boardFindings.length === 1
                    ? t('orch.findings.entryOne', { n: boardFindings.length })
                    : t('orch.findings.entryMany', { n: boardFindings.length })}
              </span>
            </div>
            <div className="findings-board" title={t('orch.findings.boardTitle')}>
              {boardFindings.slice(0, MAX_VISIBLE_FINDINGS).map((finding) => (
                <div key={finding.id} className={`finding-entry kind-${finding.kind}`}>
                  <div className="finding-head">
                    <span className="finding-kind">{t(`orch.kind.${finding.kind}`)}</span>
                    <strong className="finding-title">{finding.title}</strong>
                    <span className="finding-meta">
                      {finding.agentName ? <LoreName name={finding.agentName} /> : (finding.role ?? finding.taskId)}
                      {' · '}
                      {t('orch.findings.ago', { age: fmtAge(now - finding.createdAt) })}
                    </span>
                  </div>
                  <p className="finding-detail">{finding.detail}</p>
                  {finding.files?.length ? (
                    <code className="finding-files" title={t('orch.findings.filesTitle')}>{finding.files.join(', ')}</code>
                  ) : null}
                </div>
              ))}
            </div>
          </>
        )}
      </div>

      <div className="orch-panel-body">
        <div className="dag-caption">
          <span>{t('orch.dag.caption')}</span>
          <span className="tag">DAG</span>
        </div>
        <div className="dag-scroll">
          {tasks.length === 0 ? (
            <div className="dag-empty">
              {t('orch.dag.emptyLead')} <code>dispatch_subagent</code> {t('orch.dag.emptyTail')}
            </div>
          ) : (
            tasks.map((task) => (
              <TaskCard
                key={task.id}
                task={task}
                usage={task.agentId ? usageByAgentId.get(task.agentId) : undefined}
                profileId={store.activeProfileId}
                workspaceSessionId={store.activeWorkspaceSessionId ?? undefined}
                now={now}
              />
            ))
          )}
        </div>

        <div className="dispatch">
          <div className="dispatch-head">
            <span className="caption">{t('orch.dispatch.caption')}</span>
            <span className="dot" />
            <div className="spacer" />
            <span className="clock">{fmtTime(now)}</span>
          </div>
          <div className="dispatch-body" ref={logRef}>
            {events.length === 0 && (
              <div className="dispatch-line tone-muted">{t('orch.dispatch.ready')}</div>
            )}
            {events.map((evt, i) => (
              <div key={i} className={`dispatch-line tone-${evt.tone}`}>
                <span className="time">{fmtTime(evt.time)}</span> {evt.text}
              </div>
            ))}
          </div>
        </div>
      </div>
      </div>
    </section>
  )
}

export function CollapsedOrchestratorPanel({ onToggle }: { onToggle: () => void }): JSX.Element {
  const { t } = useTranslation()
  return (
    <aside
      id="orchestrator-right-panel"
      className="orch-panel layout-panel panel-collapsed"
      aria-label={t('orch.panelAria')}
    >
      <div className="panel-control-row panel-control-row-right">
        <button
          type="button"
          className="panel-collapse-button"
          aria-controls="orchestrator-right-content"
          aria-expanded="false"
          aria-label={t('orch.expand')}
          title={t('orch.expand')}
          onClick={onToggle}
        >
          ‹
        </button>
      </div>
    </aside>
  )
}

export default function OrchestratorPanel(): JSX.Element {
  const { t } = useTranslation()
  const layout = useLayoutStore(selectPanelLayout('orchestrator-right'))
  const toggleCollapsed = useLayoutStore((state) => state.toggleCollapsed)
  const toggle = (): void => toggleCollapsed('orchestrator-right')

  if (layout.collapsed) {
    return <CollapsedOrchestratorPanel onToggle={toggle} />
  }

  return (
    <>
      <ResizeHandle
        panelId="orchestrator-right"
        direction="left"
        ariaLabel={t('orch.resize')}
      />
      <OrchestratorPanelContent width={layout.width} onCollapse={toggle} />
    </>
  )
}
