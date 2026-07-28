import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import type { TaskReviewDiff } from '@shared/ipc'
import type { IntegrationCenterItem, VertragusTask } from '@shared/orchestrator'
import { useAppStore } from '@renderer/store/useAppStore'
import DiffView, { countDiffFiles } from './diff/DiffView'
import ErrorCard from './ui/ErrorCard'
import Spinner from './ui/Spinner'
import styles from './DiffMergeCenter.module.css'

function message(error: unknown): string { return error instanceof Error ? error.message : String(error) }

interface OpenDiff extends TaskReviewDiff {
  title: string
  profileId: string
  sessionId: string
  /** The engine recorded a live (or recovered) worktree for this task. */
  canOpenWorktree: boolean
}

/** One compact metadata line per integration entry, derived from snapshot data only. */
function changeMeta(t: TFunction, item: IntegrationCenterItem, task: VertragusTask | undefined): string {
  const parts: string[] = [item.status]
  parts.push(item.commit ? item.commit.slice(0, 10) : t('diffMerge.meta.noCommit'))
  if (item.branch) parts.push(item.branch)
  if (item.remoteCiStatus) parts.push(`CI ${item.remoteCiStatus}`)
  parts.push(item.findingCount === 0
    ? t('diffMerge.meta.noFindings')
    : item.findingCount === 1
      ? t('diffMerge.meta.findingOne', { n: item.findingCount })
      : t('diffMerge.meta.findingMany', { n: item.findingCount }))
  if (task?.agentName) parts.push(task.model ? `${task.agentName} (${task.model})` : task.agentName)
  return parts.join(' · ')
}

export default function DiffMergeCenter(): JSX.Element {
  const { t } = useTranslation()
  const snapshots = useAppStore((state) => state.orchestrators)
  const sessions = useAppStore((state) => state.workspaceSessions)
  const [diff, setDiff] = useState<OpenDiff>()
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState<string>()
  const values = Object.values(snapshots).filter((snapshot) =>
    snapshot.workspaceSessionId && snapshot.integration && (
      snapshot.integration.items.length > 0 || snapshot.integration.status !== 'idle'
    )
  )

  // Remember the last failed call so the error card can offer a retry.
  const lastFailed = useRef<{ key: string; operation: () => Promise<unknown> }>()

  const run = async (key: string, operation: () => Promise<unknown>): Promise<void> => {
    setBusy(key); setError(undefined)
    try {
      await operation()
      lastFailed.current = undefined
    } catch (value) {
      lastFailed.current = { key, operation }
      setError(message(value))
    } finally {
      setBusy(undefined)
    }
  }

  const retryLastAction = (): void => {
    const failed = lastFailed.current
    if (failed) void run(failed.key, failed.operation)
  }

  const fileCount = diff ? countDiffFiles(diff.diff) : 0

  return (
    <main className="mission-surface" aria-label={t('diffMerge.aria')}>
      <header className="mission-header">
        <div><span className="eyebrow">{t('diffMerge.eyebrow')}</span><h1>{t('diffMerge.title')}</h1></div>
        <span className="mission-count">{t('diffMerge.changes', { n: values.reduce((sum, snapshot) => sum + (snapshot.integration?.items.length ?? 0), 0) })}</span>
      </header>
      {error && (
        <ErrorCard
          title={t('ui.actionFailed')}
          detail={error}
          onRetry={retryLastAction}
          retryDisabled={Boolean(busy)}
        />
      )}
      {diff && <section className="mission-diff-modal">
        <div>
          <strong>{diff.title}</strong>
          <div className={styles.modalActions}>
            {fileCount > 0 && <span className={styles.fileCount}>{fileCount === 1 ? t('diffMerge.fileOne', { n: fileCount }) : t('diffMerge.fileMany', { n: fileCount })}</span>}
            <button
              type="button"
              className="secondary"
              disabled={!diff.canOpenWorktree || busy === 'worktree'}
              title={diff.canOpenWorktree
                ? t('orch.task.openWorktreeHint')
                : t('diffMerge.noWorktree')}
              onClick={() => void run('worktree', () =>
                window.vertragus.orchestrator.openTaskWorktree(diff.profileId, diff.taskId, diff.sessionId))}
            >{t('orch.task.openWorktree')}</button>
            <button type="button" onClick={() => setDiff(undefined)}>{t('diffMerge.close')}</button>
          </div>
        </div>
        <DiffView diff={diff.diff} />
        {diff.truncated && <small className={styles.truncatedNote}>{t('diffMerge.truncated')}</small>}
      </section>}
      {values.length === 0 && <div className="mission-empty"><strong>{t('diffMerge.emptyTitle')}</strong><span>{t('diffMerge.emptyHint')}</span></div>}
      <section className="mission-integration-list">
        {values.map((snapshot) => {
          const integration = snapshot.integration!
          const sessionId = snapshot.workspaceSessionId!
          const name = sessions.find((session) => session.id === sessionId)?.name ?? sessionId
          const publication = snapshot.pendingApprovals?.find((approval) => approval.kind === 'pr-publication')
          return <article className={`mission-integration status-${integration.status}`} key={sessionId}>
            <header><div><strong>{name}</strong><small>{snapshot.profileId}</small></div><span>{integration.status}</span></header>
            {integration.items.map((item) => {
              const task = snapshot.tasks.find((entry) => entry.id === item.taskId)
              return <div className="mission-change" key={item.taskId}>
                <div>
                  <strong>{item.title}</strong>
                  <small>{changeMeta(t, item, task)}</small>
                  {item.remoteCiSummary && <small>{item.remoteCiSummary}</small>}
                  {(item.prUrl || (item.remoteCiUrl && item.remoteCiUrl !== item.prUrl)) && (
                    <span className={styles.changeLinks}>
                      {item.prUrl && <a href={item.prUrl} target="_blank" rel="noreferrer">{t('diffMerge.openPr')}</a>}
                      {item.remoteCiUrl && item.remoteCiUrl !== item.prUrl && (
                        <a href={item.remoteCiUrl} target="_blank" rel="noreferrer">{t('diffMerge.ciChecks')}</a>
                      )}
                    </span>
                  )}
                </div>
                <button type="button" className="secondary" disabled={!task?.commit && !task?.branch} onClick={() => void run(`diff:${item.taskId}`, async () => {
                  const value = await window.vertragus.orchestrator.taskDiff(snapshot.profileId!, item.taskId, sessionId)
                  setDiff({
                    ...value,
                    title: item.title,
                    profileId: snapshot.profileId!,
                    sessionId,
                    canOpenWorktree: Boolean(task?.worktree ?? task?.recoveryArtifact?.worktree)
                  })
                })}>{t('diffMerge.diff')}</button>
              </div>
            })}
            {publication && <div className="mission-actions">
              <button type="button" disabled={Boolean(busy)} onClick={() => void run(`publish:${sessionId}`, () => window.vertragus.orchestrator.approvePublication(snapshot.profileId!, sessionId, publication.task?.planId))}>
                {busy === `publish:${sessionId}` ? <><Spinner /> {t('diffMerge.publishing')}</> : t('diffMerge.publish')}
              </button>
              <button type="button" className="secondary" disabled={Boolean(busy)} onClick={() => void run(`reject:${sessionId}`, () => window.vertragus.orchestrator.rejectPublication(snapshot.profileId!, sessionId, publication.task?.planId))}>
                {busy === `reject:${sessionId}` ? <><Spinner /> {t('diffMerge.rejecting')}</> : t('diffMerge.reject')}
              </button>
            </div>}
          </article>
        })}
      </section>
    </main>
  )
}
