import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { deriveRemoteApprovals, type ApprovalItem } from '@shared/remote'
import type { OrchestratorSnapshot } from '@shared/orchestrator'
import type { TaskReviewDiff } from '@shared/ipc'
import { useAppStore } from '@renderer/store/useAppStore'

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function approvalLabel(t: TFunction, item: ApprovalItem): string {
  switch (item.kind) {
    case 'plan-review': return t('modals.approvals.kind.planReview')
    case 'pr-publication': return t('modals.approvals.kind.prPublication')
    case 'tool-permission': return t('modals.approvals.kind.toolPermission')
    case 'budget-exceeded': return t('modals.approvals.kind.budgetExceeded')
    case 'provider-limit': return t('modals.approvals.kind.providerLimit')
    default: return t('modals.approvals.kind.blockedTask')
  }
}

function sessionSnapshots(values: Record<string, OrchestratorSnapshot>): OrchestratorSnapshot[] {
  return Object.values(values).filter((snapshot) => snapshot.profileId && snapshot.workspaceSessionId)
}

export default function MissionApprovalInbox(): JSX.Element {
  const { t } = useTranslation()
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
        case 'plan.approve': return window.vertragus.orchestrator.reviewPlan(profileId, true, sessionId)
        case 'plan.reject': return window.vertragus.orchestrator.reviewPlan(profileId, false, sessionId)
        case 'publication.approve': return window.vertragus.orchestrator.approvePublication(profileId, sessionId, approval.task?.planId)
        case 'publication.reject': return window.vertragus.orchestrator.rejectPublication(profileId, sessionId, approval.task?.planId)
        case 'permission.allow': return window.vertragus.orchestrator.resolvePermission(profileId, sessionId, approval.permission!.id, true)
        case 'permission.deny': return window.vertragus.orchestrator.resolvePermission(profileId, sessionId, approval.permission!.id, false)
        case 'task.fallback': return window.vertragus.orchestrator.fallbackTask(profileId, sessionId, approval.task!.id)
        case 'mode.enableAuto': return window.vertragus.orchestrator.enableAutoMode(profileId, sessionId)
        case 'run.reset': return window.vertragus.orchestrator.reset(profileId, sessionId)
        default: return false
      }
    })
  }

  const showDiff = (approval: ApprovalItem): void => {
    if (!approval.task) return
    void run(`diff:${approval.id}`, async () => {
      const value = await window.vertragus.orchestrator.taskDiff(
        approval.profileId,
        approval.task!.id,
        approval.workspaceSessionId
      )
      setDiff({ ...value, title: approval.title })
    })
  }

  return (
    <main className="mission-surface" aria-label={t('modals.approvals.aria')}>
      <header className="mission-header">
        <div><span className="eyebrow">{t('modals.approvals.eyebrow')}</span><h1>{t('modals.approvals.title')}</h1></div>
        <span className={`mission-count ${approvals.length ? 'attention' : ''}`}>{t('modals.approvals.openCount', { n: approvals.length })}</span>
      </header>
      {error && <div className="mission-error" role="alert">{error}</div>}

      <section className="mission-budget-grid" aria-label={t('modals.approvals.budgetsAria')}>
        {sessionSnapshots(snapshots).map((snapshot) => {
          const sessionId = snapshot.workspaceSessionId!
          const draft = budgetDrafts[sessionId] ?? { tokens: '', cost: '' }
          const budget = snapshot.budget
          const sessionName = sessions.find((session) => session.id === sessionId)?.name ?? sessionId
          return (
            <article className={`mission-budget-card ${budget?.exceeded ? 'exceeded' : ''}`} key={sessionId}>
              <div><strong>{sessionName}</strong><small>{snapshot.profileId}</small></div>
              <p>{t('modals.approvals.budgetLine', { tokens: budget?.tokens.toLocaleString() ?? '—', cost: budget?.costUsd.toFixed(2) ?? '—' })}</p>
              <small>
                {t('modals.approvals.telemetry', {
                  reported: budget?.tasksReported ?? 0,
                  total: budget?.tasksTotal ?? snapshot.tasks.length,
                  tokens: budget?.tokenDataComplete
                    ? t('modals.approvals.complete')
                    : t('modals.approvals.partial'),
                  cost: budget?.costDataComplete
                    ? t('modals.approvals.complete')
                    : t('modals.approvals.partial')
                })}
              </small>
              <div className="mission-budget-inputs">
                <input
                  inputMode="numeric"
                  value={draft.tokens}
                  placeholder={String(budget?.caps.maxTokens ?? t('modals.approvals.tokenCap'))}
                  onChange={(event) => setBudgetDrafts((current) => ({
                    ...current, [sessionId]: { ...draft, tokens: event.target.value }
                  }))}
                />
                <input
                  inputMode="decimal"
                  value={draft.cost}
                  placeholder={String(budget?.caps.maxCostUsd ?? t('modals.approvals.usdCap'))}
                  onChange={(event) => setBudgetDrafts((current) => ({
                    ...current, [sessionId]: { ...draft, cost: event.target.value }
                  }))}
                />
                <button
                  type="button"
                  disabled={busy === `budget:${sessionId}`}
                  onClick={() => void run(`budget:${sessionId}`, () => window.vertragus.orchestrator.setBudgetCaps(
                    snapshot.profileId!, sessionId, {
                      maxTokens: draft.tokens ? Number(draft.tokens) : undefined,
                      maxCostUsd: draft.cost ? Number(draft.cost) : undefined
                    }
                  ))}
                >{t('modals.approvals.setCaps')}</button>
              </div>
              {snapshot.tasks.filter((task) => task.status === 'paused').map((task) => (
                <button
                  type="button"
                  className="secondary"
                  key={task.id}
                  onClick={() => void run(`resume:${task.id}`, () =>
                    window.vertragus.orchestrator.resumeTask(snapshot.profileId!, sessionId, task.id))}
                >{t('modals.approvals.resume', { title: task.title })}</button>
              ))}
            </article>
          )
        })}
      </section>

      {diff && (
        <section className="mission-diff-modal">
          <div><strong>{diff.title}</strong><button type="button" onClick={() => setDiff(undefined)}>{t('modals.approvals.close')}</button></div>
          <pre>{diff.diff}</pre>
          {diff.truncated && <small>{t('modals.approvals.truncated')}</small>}
        </section>
      )}

      <section className="mission-approval-list">
        {approvals.length === 0 && <div className="mission-empty"><strong>{t('modals.approvals.allDecided')}</strong><span>{t('modals.approvals.empty')}</span></div>}
        {approvals.map((approval) => (
          <article className={`mission-approval kind-${approval.kind}`} key={approval.id}>
            <small>{approvalLabel(t, approval)} · {approval.profileId}</small>
            <h2>{approval.title}</h2>
            <p>{approval.summary}</p>
            {approval.task && <button type="button" className="secondary" onClick={() => showDiff(approval)}>{t('modals.approvals.viewDiff')}</button>}
            <div className="mission-actions">
              {approval.actions.filter((action) => action !== 'budget.setCaps').map((action) => (
                <button
                  type="button"
                  className={action.endsWith('reject') || action.endsWith('deny') || action === 'run.reset' ? 'secondary' : ''}
                  disabled={Boolean(busy)}
                  key={action}
                  onClick={() => act(approval, action)}
                >{
                  action === 'plan.approve' ? t('modals.approvals.actions.planApprove') :
                    action === 'plan.reject' ? t('modals.approvals.actions.planReject') :
                      action === 'publication.approve' ? t('modals.approvals.actions.publicationApprove') :
                        action === 'publication.reject' ? t('modals.approvals.actions.publicationReject') :
                          action === 'permission.allow' ? t('modals.approvals.actions.permissionAllow') :
                            action === 'permission.deny' ? t('modals.approvals.actions.permissionDeny') :
                              action === 'task.fallback' ? t('modals.approvals.actions.taskFallback') :
                                action === 'mode.enableAuto' ? t('modals.approvals.actions.modeEnableAuto') : t('modals.approvals.actions.runReset')
                }</button>
              ))}
            </div>
          </article>
        ))}
      </section>
    </main>
  )
}
