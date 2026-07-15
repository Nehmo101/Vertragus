import { useMemo, useState } from 'react'
import { deriveRemoteApprovals, type ApprovalItem } from '@shared/remote'
import type { OrchestratorSnapshot } from '@shared/orchestrator'
import type { TaskReviewDiff } from '@shared/ipc'
import { useAppStore } from '@renderer/store/useAppStore'

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function approvalLabel(item: ApprovalItem): string {
  switch (item.kind) {
    case 'plan-review': return 'Plan-Review'
    case 'pr-publication': return 'PR-Veröffentlichung'
    case 'tool-permission': return 'Tool-Berechtigung'
    case 'budget-exceeded': return 'Budget erreicht'
    case 'provider-limit': return 'Provider-Limit'
    default: return 'Blockierte Aufgabe'
  }
}

function sessionSnapshots(values: Record<string, OrchestratorSnapshot>): OrchestratorSnapshot[] {
  return Object.values(values).filter((snapshot) => snapshot.profileId && snapshot.workspaceSessionId)
}

export default function MissionApprovalInbox(): JSX.Element {
  const snapshots = useAppStore((state) => state.orchestrators)
  const sessions = useAppStore((state) => state.workspaceSessions)
  const approvals = useMemo(() => deriveRemoteApprovals(sessionSnapshots(snapshots)), [snapshots])
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState<string>()
  const [diff, setDiff] = useState<TaskReviewDiff & { title: string }>()
  const [budgetDrafts, setBudgetDrafts] = useState<Record<string, { tokens: string; cost: string }>>({})

  const run = async (key: string, operation: () => Promise<unknown>): Promise<void> => {
    setBusy(key)
    setError(undefined)
    try { await operation() } catch (value) { setError(message(value)) } finally { setBusy(undefined) }
  }

  const act = (approval: ApprovalItem, action: ApprovalItem['actions'][number]): void => {
    const profileId = approval.profileId
    const sessionId = approval.workspaceSessionId
    void run(`${approval.id}:${action}`, async () => {
      switch (action) {
        case 'plan.approve': return window.orca.orchestrator.reviewPlan(profileId, true, sessionId)
        case 'plan.reject': return window.orca.orchestrator.reviewPlan(profileId, false, sessionId)
        case 'publication.approve': return window.orca.orchestrator.approvePublication(profileId, sessionId, approval.task?.planId)
        case 'publication.reject': return window.orca.orchestrator.rejectPublication(profileId, sessionId, approval.task?.planId)
        case 'permission.allow': return window.orca.orchestrator.resolvePermission(profileId, sessionId, approval.permission!.id, true)
        case 'permission.deny': return window.orca.orchestrator.resolvePermission(profileId, sessionId, approval.permission!.id, false)
        case 'task.fallback': return window.orca.orchestrator.fallbackTask(profileId, sessionId, approval.task!.id)
        case 'mode.enableAuto': return window.orca.orchestrator.enableAutoMode(profileId, sessionId)
        case 'run.reset': return window.orca.orchestrator.reset(profileId, sessionId)
        default: return false
      }
    })
  }

  const showDiff = (approval: ApprovalItem): void => {
    if (!approval.task) return
    void run(`diff:${approval.id}`, async () => {
      const value = await window.orca.orchestrator.taskDiff(
        approval.profileId,
        approval.task!.id,
        approval.workspaceSessionId
      )
      setDiff({ ...value, title: approval.title })
    })
  }

  return (
    <main className="mission-surface" aria-label="Approval-Inbox">
      <header className="mission-header">
        <div><span className="eyebrow">Mission Control</span><h1>Approval-Inbox</h1></div>
        <span className={`mission-count ${approvals.length ? 'attention' : ''}`}>{approvals.length} offen</span>
      </header>
      {error && <div className="mission-error" role="alert">{error}</div>}

      <section className="mission-budget-grid" aria-label="Laufbudgets">
        {sessionSnapshots(snapshots).map((snapshot) => {
          const sessionId = snapshot.workspaceSessionId!
          const draft = budgetDrafts[sessionId] ?? { tokens: '', cost: '' }
          const budget = snapshot.budget
          const sessionName = sessions.find((session) => session.id === sessionId)?.name ?? sessionId
          return (
            <article className={`mission-budget-card ${budget?.exceeded ? 'exceeded' : ''}`} key={sessionId}>
              <div><strong>{sessionName}</strong><small>{snapshot.profileId}</small></div>
              <p>{budget?.tokens.toLocaleString() ?? '—'} Token · ${budget?.costUsd.toFixed(2) ?? '—'}</p>
              <small>
                Telemetrie {budget?.tasksReported ?? 0}/{budget?.tasksTotal ?? snapshot.tasks.length} Tasks ·
                Token {budget?.tokenDataComplete ? 'vollständig' : 'teilweise'} · Kosten {budget?.costDataComplete ? 'vollständig' : 'teilweise'}
              </small>
              <div className="mission-budget-inputs">
                <input
                  inputMode="numeric"
                  value={draft.tokens}
                  placeholder={String(budget?.caps.maxTokens ?? 'Token-Cap')}
                  onChange={(event) => setBudgetDrafts((current) => ({
                    ...current, [sessionId]: { ...draft, tokens: event.target.value }
                  }))}
                />
                <input
                  inputMode="decimal"
                  value={draft.cost}
                  placeholder={String(budget?.caps.maxCostUsd ?? 'USD-Cap')}
                  onChange={(event) => setBudgetDrafts((current) => ({
                    ...current, [sessionId]: { ...draft, cost: event.target.value }
                  }))}
                />
                <button
                  type="button"
                  disabled={busy === `budget:${sessionId}`}
                  onClick={() => void run(`budget:${sessionId}`, () => window.orca.orchestrator.setBudgetCaps(
                    snapshot.profileId!, sessionId, {
                      maxTokens: draft.tokens ? Number(draft.tokens) : undefined,
                      maxCostUsd: draft.cost ? Number(draft.cost) : undefined
                    }
                  ))}
                >Caps setzen</button>
              </div>
              {snapshot.tasks.filter((task) => task.status === 'paused').map((task) => (
                <button
                  type="button"
                  className="secondary"
                  key={task.id}
                  onClick={() => void run(`resume:${task.id}`, () =>
                    window.orca.orchestrator.resumeTask(snapshot.profileId!, sessionId, task.id))}
                >{task.title} fortsetzen</button>
              ))}
            </article>
          )
        })}
      </section>

      {diff && (
        <section className="mission-diff-modal">
          <div><strong>{diff.title}</strong><button type="button" onClick={() => setDiff(undefined)}>Schließen</button></div>
          <pre>{diff.diff}</pre>
          {diff.truncated && <small>Die Anzeige wurde sicher gekürzt.</small>}
        </section>
      )}

      <section className="mission-approval-list">
        {approvals.length === 0 && <div className="mission-empty"><strong>Alles entschieden</strong><span>Keine Session wartet auf eine Freigabe.</span></div>}
        {approvals.map((approval) => (
          <article className={`mission-approval kind-${approval.kind}`} key={approval.id}>
            <small>{approvalLabel(approval)} · {approval.profileId}</small>
            <h2>{approval.title}</h2>
            <p>{approval.summary}</p>
            {approval.task && <button type="button" className="secondary" onClick={() => showDiff(approval)}>Diff ansehen</button>}
            <div className="mission-actions">
              {approval.actions.filter((action) => action !== 'budget.setCaps').map((action) => (
                <button
                  type="button"
                  className={action.endsWith('reject') || action.endsWith('deny') || action === 'run.reset' ? 'secondary' : ''}
                  disabled={Boolean(busy)}
                  key={action}
                  onClick={() => act(approval, action)}
                >{
                  action === 'plan.approve' ? 'Plan freigeben' :
                    action === 'plan.reject' ? 'Ablehnen' :
                      action === 'publication.approve' ? 'PR veröffentlichen' :
                        action === 'publication.reject' ? 'Nicht veröffentlichen' :
                          action === 'permission.allow' ? 'Einmal erlauben' :
                            action === 'permission.deny' ? 'Verweigern' :
                              action === 'task.fallback' ? 'Sicherer Provider-Fallback' :
                                action === 'mode.enableAuto' ? 'Auto-Modus aktivieren' : 'Lauf zurücksetzen'
                }</button>
              ))}
            </div>
          </article>
        ))}
      </section>
    </main>
  )
}
