import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { OrphanedWorktreeInfo, SessionRestoreStatus } from '@shared/sessions'

type OrphanGroup = {
  sessionId: string
  items: OrphanedWorktreeInfo[]
  dirtyCount: number
}

function groupOrphans(orphans: OrphanedWorktreeInfo[]): OrphanGroup[] {
  const bySession = new Map<string, OrphanedWorktreeInfo[]>()
  for (const orphan of orphans) {
    const list = bySession.get(orphan.sessionId) ?? []
    list.push(orphan)
    bySession.set(orphan.sessionId, list)
  }
  return [...bySession.entries()]
    .map(([sessionId, items]) => ({
      sessionId,
      items,
      dirtyCount: items.filter((item) => item.changedFiles != null && item.changedFiles > 0).length
    }))
    .sort((a, b) => b.items.length - a.items.length || a.sessionId.localeCompare(b.sessionId))
}

/**
 * Startup recovery panel: structured restart / cleanup after a clean restore
 * or unexpected exit. Orphans stay collapsed by default so large leftovers
 * never drown the primary "restart team" actions.
 */
export default function SessionRestoreBanner(): JSX.Element | null {
  const { t } = useTranslation()
  const [status, setStatus] = useState<SessionRestoreStatus | null>(null)
  const [dismissed, setDismissed] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [orphansOpen, setOrphansOpen] = useState(false)
  const [staleOpen, setStaleOpen] = useState(false)
  const [expandedSessions, setExpandedSessions] = useState<Set<string>>(() => new Set())

  const refresh = (): void => {
    void window.vertragus.sessions
      .restoreStatus()
      .then(setStatus)
      .catch(() => setStatus(null))
  }

  useEffect(refresh, [])

  const orphanGroups = useMemo(
    () => (status ? groupOrphans(status.orphanedWorktrees) : []),
    [status]
  )
  const dirtyOrphans = useMemo(
    () => status?.orphanedWorktrees.filter((item) => (item.changedFiles ?? 0) > 0) ?? [],
    [status]
  )
  // Only treat explicitly clean trees as bulk-safe; unknown git status stays out.
  const cleanOrphans = useMemo(
    () => status?.orphanedWorktrees.filter((item) => item.changedFiles === 0) ?? [],
    [status]
  )

  if (dismissed || !status) return null
  const hasContent =
    !status.cleanShutdown ||
    status.resumableSessions.length > 0 ||
    status.orphanedWorktrees.length > 0 ||
    status.staleSessions.length > 0
  if (!hasContent) return null

  const run = async (key: string, action: () => Promise<unknown>): Promise<void> => {
    setBusy(key)
    setError(null)
    try {
      await action()
      refresh()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(null)
    }
  }

  const discardPaths = (key: string, paths: string[], confirmKey: 'discardConfirm' | 'discardCleanConfirm' | 'discardAllConfirm'): void => {
    if (paths.length === 0) return
    const sample = paths[0] ?? ''
    if (!window.confirm(t(`restore.${confirmKey}`, { count: paths.length, path: sample }))) return
    void run(key, () => window.vertragus.sessions.discardOrphanWorktrees(paths))
  }

  const toggleSession = (sessionId: string): void => {
    setExpandedSessions((prev) => {
      const next = new Set(prev)
      if (next.has(sessionId)) next.delete(sessionId)
      else next.add(sessionId)
      return next
    })
  }

  const restartAll = async (): Promise<void> => {
    setBusy('restart-all')
    setError(null)
    try {
      for (const session of status.resumableSessions) {
        await window.vertragus.sessions.restartAgents(session.profileId, session.id)
      }
      refresh()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="restore-banner" role="region" aria-label={t('restore.title')}>
      <div className="restore-head">
        <div className="restore-head-copy">
          <span className="head">
            {status.cleanShutdown ? t('restore.title') : t('restore.titleCrash')}
          </span>
          <span className="rest">
            {status.restoredSessions > 0
              ? t('restore.summary', { count: status.restoredSessions })
              : t('restore.summaryNone')}
          </span>
        </div>
        <div className="restore-head-actions">
          {status.resumableSessions.length > 1 && (
            <button
              type="button"
              className="btn primary"
              disabled={busy != null}
              onClick={() => void restartAll()}
            >
              {busy === 'restart-all' ? t('restore.restarting') : t('restore.restartAll')}
            </button>
          )}
          {status.resumableSessions.length === 1 && (
            <button
              type="button"
              className="btn primary"
              disabled={busy != null}
              onClick={() => {
                const session = status.resumableSessions[0]!
                void run(`restart-${session.id}`, () =>
                  window.vertragus.sessions.restartAgents(session.profileId, session.id)
                )
              }}
            >
              {busy === `restart-${status.resumableSessions[0]!.id}`
                ? t('restore.restarting')
                : t('restore.restart', { count: status.resumableSessions[0]!.agentCount })}
            </button>
          )}
          <button
            type="button"
            className={status.resumableSessions.length > 0 ? 'btn ghost' : 'btn primary'}
            disabled={busy != null}
            onClick={() => setDismissed(true)}
          >
            {status.resumableSessions.length > 0 ? t('restore.continue') : t('restore.continueClean')}
          </button>
        </div>
      </div>

      {error && <div className="restore-error">{error}</div>}

      {status.resumableSessions.length > 0 && (
        <section className="restore-section">
          <div className="restore-section-head">
            <span className="restore-label">{t('restore.resumable')}</span>
            <span className="restore-meta">
              {t('restore.resumableMeta', { count: status.resumableSessions.length })}
            </span>
          </div>
          <ul className="restore-list">
            {status.resumableSessions.map((session) => (
              <li key={session.id} className="restore-card">
                <div className="restore-card-main">
                  <strong>{session.name || session.id.slice(0, 8)}</strong>
                  <span className="restore-meta">
                    {t('restore.agentMeta', { count: session.agentCount })}
                    {' · '}
                    {t('restore.capturedAt', {
                      date: new Date(session.capturedAt).toLocaleString()
                    })}
                  </span>
                </div>
                <button
                  type="button"
                  className="btn primary"
                  disabled={busy != null}
                  onClick={() =>
                    void run(`restart-${session.id}`, () =>
                      window.vertragus.sessions.restartAgents(session.profileId, session.id)
                    )
                  }
                >
                  {busy === `restart-${session.id}`
                    ? t('restore.restarting')
                    : t('restore.restart', { count: session.agentCount })}
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {status.orphanedWorktrees.length > 0 && (
        <section className="restore-section">
          <div className="restore-section-head">
            <button
              type="button"
              className="restore-toggle"
              aria-expanded={orphansOpen}
              onClick={() => setOrphansOpen((open) => !open)}
            >
              <span className="restore-label">
                {t('restore.orphans', { count: status.orphanedWorktrees.length })}
              </span>
              <span className="restore-meta">
                {t('restore.orphansMeta', {
                  groups: orphanGroups.length,
                  dirty: dirtyOrphans.length,
                  clean: cleanOrphans.length
                })}
              </span>
              <span className="restore-chevron" aria-hidden>
                {orphansOpen ? '▾' : '▸'}
              </span>
            </button>
            <div className="restore-section-actions">
              {cleanOrphans.length > 0 && (
                <button
                  type="button"
                  className="btn ghost"
                  disabled={busy != null}
                  onClick={() =>
                    discardPaths(
                      'orphans-clean',
                      cleanOrphans.map((item) => item.path),
                      'discardCleanConfirm'
                    )
                  }
                >
                  {busy === 'orphans-clean'
                    ? t('restore.discarding')
                    : t('restore.discardClean', { count: cleanOrphans.length })}
                </button>
              )}
              <button
                type="button"
                className="btn ghost"
                disabled={busy != null}
                onClick={() =>
                  discardPaths(
                    'orphans-all',
                    status.orphanedWorktrees.map((item) => item.path),
                    'discardAllConfirm'
                  )
                }
              >
                {busy === 'orphans-all'
                  ? t('restore.discarding')
                  : t('restore.discardAll', { count: status.orphanedWorktrees.length })}
              </button>
            </div>
          </div>
          {orphansOpen && (
            <ul className="restore-list restore-list-scroll">
              {orphanGroups.map((group) => {
                const open = expandedSessions.has(group.sessionId) || orphanGroups.length === 1
                return (
                  <li key={group.sessionId} className="restore-group">
                    <button
                      type="button"
                      className="restore-group-head"
                      aria-expanded={open}
                      onClick={() => toggleSession(group.sessionId)}
                    >
                      <strong>{group.sessionId}</strong>
                      <span className="restore-meta">
                        {t('restore.orphanGroupMeta', {
                          count: group.items.length,
                          dirty: group.dirtyCount
                        })}
                      </span>
                      <span className="restore-chevron" aria-hidden>
                        {open ? '▾' : '▸'}
                      </span>
                    </button>
                    {open && (
                      <ul className="restore-sublist">
                        {group.items.map((worktree) => (
                          <li key={worktree.path} className="restore-card restore-card-compact" title={worktree.path}>
                            <div className="restore-card-main">
                              <code>{worktree.agentId}</code>
                              {worktree.changedFiles != null && worktree.changedFiles > 0 ? (
                                <em>{t('restore.changedFiles', { count: worktree.changedFiles })}</em>
                              ) : (
                                <em>{t('restore.cleanWorktree')}</em>
                              )}
                            </div>
                            <button
                              type="button"
                              className="btn ghost"
                              disabled={busy != null}
                              onClick={() => {
                                if (!window.confirm(t('restore.discardConfirm', { count: 1, path: worktree.path }))) {
                                  return
                                }
                                void run(`orphan-${worktree.path}`, () =>
                                  window.vertragus.sessions.discardOrphanWorktree(worktree.path)
                                )
                              }}
                            >
                              {t('restore.discard')}
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </li>
                )
              })}
            </ul>
          )}
        </section>
      )}

      {status.staleSessions.length > 0 && (
        <section className="restore-section">
          <div className="restore-section-head">
            <button
              type="button"
              className="restore-toggle"
              aria-expanded={staleOpen}
              onClick={() => setStaleOpen((open) => !open)}
            >
              <span className="restore-label">
                {t('restore.stale', { count: status.staleSessions.length })}
              </span>
              <span className="restore-chevron" aria-hidden>
                {staleOpen ? '▾' : '▸'}
              </span>
            </button>
          </div>
          {staleOpen && (
            <ul className="restore-list restore-list-scroll">
              {status.staleSessions.map((session) => (
                <li key={session.id} className="restore-card restore-card-compact">
                  <div className="restore-card-main">
                    <strong>{session.name || session.id.slice(0, 8)}</strong>
                    <em>{new Date(session.updatedAt).toLocaleDateString()}</em>
                  </div>
                  <button
                    type="button"
                    className="btn ghost"
                    disabled={busy != null}
                    onClick={() => {
                      if (!window.confirm(t('restore.staleConfirm'))) return
                      void run(`stale-${session.id}`, () =>
                        window.vertragus.workspaceSessions.remove(session.profileId, session.id)
                      )
                    }}
                  >
                    {t('restore.discard')}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
  )
}
