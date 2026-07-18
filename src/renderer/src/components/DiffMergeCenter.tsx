import { useState } from 'react'
import type { TaskReviewDiff } from '@shared/ipc'
import { useAppStore } from '@renderer/store/useAppStore'

function message(error: unknown): string { return error instanceof Error ? error.message : String(error) }

export default function DiffMergeCenter(): JSX.Element {
  const snapshots = useAppStore((state) => state.orchestrators)
  const sessions = useAppStore((state) => state.workspaceSessions)
  const [diff, setDiff] = useState<TaskReviewDiff & { title: string }>()
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState<string>()
  const values = Object.values(snapshots).filter((snapshot) =>
    snapshot.workspaceSessionId && snapshot.integration && (
      snapshot.integration.items.length > 0 || snapshot.integration.status !== 'idle'
    )
  )

  const run = async (key: string, operation: () => Promise<unknown>): Promise<void> => {
    setBusy(key); setError(undefined)
    try { await operation() } catch (value) { setError(message(value)) } finally { setBusy(undefined) }
  }

  return (
    <main className="mission-surface" aria-label="Diff- und Merge-Center">
      <header className="mission-header">
        <div><span className="eyebrow">Integration</span><h1>Diff &amp; Merge Center</h1></div>
        <span className="mission-count">{values.reduce((sum, snapshot) => sum + (snapshot.integration?.items.length ?? 0), 0)} Änderungen</span>
      </header>
      {error && <div className="mission-error" role="alert">{error}</div>}
      {diff && <section className="mission-diff-modal"><div><strong>{diff.title}</strong><button type="button" onClick={() => setDiff(undefined)}>Schließen</button></div><pre>{diff.diff}</pre></section>}
      {values.length === 0 && <div className="mission-empty"><strong>Noch keine Integrationen</strong><span>Verifizierte Task-Commits erscheinen hier.</span></div>}
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
                <div><strong>{item.title}</strong><small>{item.status} · {item.commit?.slice(0, 10) ?? 'kein Commit'}{item.remoteCiStatus ? ` · CI ${item.remoteCiStatus}` : ''}</small></div>
                <button type="button" className="secondary" disabled={!task?.commit && !task?.branch} onClick={() => void run(`diff:${item.taskId}`, async () => {
                  const value = await window.vertragus.orchestrator.taskDiff(snapshot.profileId!, item.taskId, sessionId)
                  setDiff({ ...value, title: item.title })
                })}>Diff</button>
              </div>
            })}
            {publication && <div className="mission-actions">
              <button type="button" disabled={Boolean(busy)} onClick={() => void run(`publish:${sessionId}`, () => window.vertragus.orchestrator.approvePublication(snapshot.profileId!, sessionId, publication.task?.planId))}>Geprüft veröffentlichen</button>
              <button type="button" className="secondary" disabled={Boolean(busy)} onClick={() => void run(`reject:${sessionId}`, () => window.vertragus.orchestrator.rejectPublication(snapshot.profileId!, sessionId, publication.task?.planId))}>Ablehnen</button>
            </div>}
          </article>
        })}
      </section>
    </main>
  )
}
