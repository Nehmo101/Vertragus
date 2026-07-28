import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type {
  DiscardOrphanFailure,
  DiscardOrphansResult,
  OrphanedWorktreeInfo,
  SessionRestoreStatus,
  StaleSessionInfo
} from '@shared/sessions'
import styles from './SessionRestoreBanner.module.css'

type OrphanGroup = {
  sessionId: string
  items: OrphanedWorktreeInfo[]
  dirtyCount: number
}

export function groupOrphans(orphans: OrphanedWorktreeInfo[]): OrphanGroup[] {
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
 * Auto-expand threshold for the compact summary row: with at most one pending
 * item there is nothing to summarize away, so the detail view shows directly.
 * Anything larger starts collapsed to keep post-crash startups uncluttered.
 */
export function shouldAutoExpand(status: SessionRestoreStatus): boolean {
  return (
    status.resumableSessions.length +
      status.orphanedWorktrees.length +
      status.staleSessions.length <=
    1
  )
}

/** Minimal translate signature so i18next's `t` can be passed straight through. */
export type RestoreTranslate = (key: string, options?: Record<string, unknown>) => string

/**
 * One-line summary for the collapsed banner, e.g.
 * "2 sessions restorable · 3 orphaned worktrees (2 with changes) · 1 old session".
 * Returns '' when there is nothing to count (crash-only banner).
 */
export function buildCompactSummary(status: SessionRestoreStatus, t: RestoreTranslate): string {
  const parts: string[] = []
  const resumable = status.resumableSessions.length
  if (resumable > 0) {
    parts.push(
      resumable === 1
        ? t('restore.summaryResumableOne')
        : t('restore.summaryResumableMany', { n: resumable })
    )
  }
  const orphans = status.orphanedWorktrees.length
  if (orphans > 0) {
    const dirty = status.orphanedWorktrees.filter((item) => (item.changedFiles ?? 0) > 0).length
    const base =
      orphans === 1 ? t('restore.summaryOrphanOne') : t('restore.summaryOrphanMany', { n: orphans })
    parts.push(dirty > 0 ? `${base}${t('restore.summaryDirtySuffix', { n: dirty })}` : base)
  }
  const stale = status.staleSessions.length
  if (stale > 0) {
    parts.push(
      stale === 1 ? t('restore.summaryStaleOne') : t('restore.summaryStaleMany', { n: stale })
    )
  }
  return parts.join(' · ')
}

export type CleanupTargets = {
  orphanPaths: string[]
  staleSessions: Array<Pick<StaleSessionInfo, 'id' | 'profileId'>>
}

/** Everything the bulk "discard & clean up" action touches, derived from the status. */
export function collectCleanupTargets(status: SessionRestoreStatus): CleanupTargets {
  return {
    orphanPaths: status.orphanedWorktrees.map((item) => item.path),
    staleSessions: status.staleSessions.map(({ id, profileId }) => ({ id, profileId }))
  }
}

/**
 * Bulk cleanup core: discard all orphaned worktrees in one IPC call, then
 * dismiss every stale session. API is injected so tests can run it without a
 * window/preload bridge. Individual stale failures are counted, not fatal.
 */
export async function runFullCleanup(
  api: {
    discardOrphanWorktrees(paths: string[]): Promise<DiscardOrphansResult>
    removeWorkspaceSession(profileId: string, sessionId: string): Promise<unknown>
  },
  targets: CleanupTargets
): Promise<DiscardOrphansResult> {
  let discarded = 0
  const failures: DiscardOrphanFailure[] = []
  if (targets.orphanPaths.length > 0) {
    const result = await api.discardOrphanWorktrees(targets.orphanPaths)
    discarded += result.discarded
    failures.push(...result.failures)
  }
  for (const session of targets.staleSessions) {
    try {
      await api.removeWorkspaceSession(session.profileId, session.id)
      discarded += 1
    } catch (cause) {
      failures.push({
        path: session.id,
        reason: cause instanceof Error ? cause.message : String(cause)
      })
    }
  }
  return { discarded, failed: failures.length, failures }
}

/** How many distinct causes the error line names before it summarizes the rest. */
const FAILURE_REASON_LIMIT = 2

/**
 * Turn a discard result into an actionable error line. "165 fehlgeschlagen"
 * alone left no way to tell a locked checkout from a guard rejection, so the
 * dominant causes (plus one example path each) are spelled out.
 */
export function describeDiscardFailure(t: RestoreTranslate, result: DiscardOrphansResult): string {
  const head = t('restore.discardResult', {
    discarded: result.discarded,
    failed: result.failed
  })
  const byReason = new Map<string, { count: number; example: string }>()
  for (const failure of result.failures) {
    const seen = byReason.get(failure.reason)
    if (seen) seen.count += 1
    else byReason.set(failure.reason, { count: 1, example: failure.path })
  }
  const ranked = [...byReason.entries()].sort((a, b) => b[1].count - a[1].count)
  const named = ranked
    .slice(0, FAILURE_REASON_LIMIT)
    .map(([reason, { count, example }]) =>
      t('restore.discardReason', { count, reason, path: example })
    )
  const rest = ranked.length - named.length
  if (rest > 0) named.push(t('restore.discardReasonMore', { count: rest }))
  return named.length > 0 ? `${head} ${named.join(' · ')}` : head
}

/**
 * Two-click confirm state machine: first click on a key arms it, a second
 * click on the same key fires; clicking a different key re-arms that one.
 */
export function resolveConfirmClick(
  confirming: string | null,
  key: string
): { confirming: string | null; fire: boolean } {
  if (confirming !== key) return { confirming: key, fire: false }
  return { confirming: null, fire: true }
}

/** Armed confirms fall back to idle after this timeout (safety against stale danger UI). */
export const CONFIRM_RESET_MS = 6000

/**
 * Startup recovery panel: structured restart / cleanup after a clean restore
 * or unexpected exit. Orphans stay collapsed by default so large leftovers
 * never drown the primary "restart team" actions.
 *
 * Dismiss ("continue") is kept for the renderer lifetime via a module flag so a
 * remount / Strict-Mode cycle cannot bring the banner back until the next app start.
 * The expand/collapse choice is kept the same way: per launch only, never persisted.
 */
let dismissedForLaunch = false
let expandedForLaunch: boolean | null = null

export default function SessionRestoreBanner(): JSX.Element | null {
  const { t } = useTranslation()
  const [status, setStatus] = useState<SessionRestoreStatus | null>(null)
  const [dismissed, setDismissed] = useState(dismissedForLaunch)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Key of the destructive action currently armed for its second (confirming) click.
  const [confirming, setConfirming] = useState<string | null>(null)
  const [orphansOpen, setOrphansOpen] = useState(false)
  const [staleOpen, setStaleOpen] = useState(false)
  const [expandedSessions, setExpandedSessions] = useState<Set<string>>(() => new Set())
  // null = no explicit choice yet → derive the default from the status (threshold).
  const [expandedPref, setExpandedPref] = useState<boolean | null>(expandedForLaunch)

  const refresh = (): Promise<void> =>
    window.vertragus.sessions
      .restoreStatus()
      .then(setStatus)
      .catch(() => setStatus(null))

  useEffect(() => {
    // Load once on mount via the promise callback (not a sync setState-in-effect).
    void window.vertragus.sessions
      .restoreStatus()
      .then(setStatus)
      .catch(() => setStatus(null))
  }, [])

  useEffect(() => {
    // Armed destructive confirms disarm themselves after a short timeout so a
    // forgotten first click cannot leave a live confirm button around.
    if (confirming == null) return
    const timer = window.setTimeout(() => setConfirming(null), CONFIRM_RESET_MS)
    return () => window.clearTimeout(timer)
  }, [confirming])

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
  // Keep the banner mounted while a discard/restart is in flight — optimistic
  // orphan removal can clear hasContent before the main process finishes.
  if (!hasContent && busy == null) return null

  const run = async (key: string, action: () => Promise<unknown>): Promise<void> => {
    setBusy(key)
    setError(null)
    setConfirming(null)
    try {
      await action()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      // Wait for the re-scan before unlocking actions — otherwise a second
      // "Verwerfen" starts while inventory is still walking the old leftovers.
      try {
        await refresh()
      } finally {
        setBusy(null)
      }
    }
  }

  const discardPaths = (key: string, paths: string[]): void => {
    if (paths.length === 0) return
    // Optimistically clear the targets so the banner shrinks immediately while
    // the main process finishes filesystem + git cleanup.
    setStatus((prev) =>
      prev
        ? {
            ...prev,
            orphanedWorktrees: prev.orphanedWorktrees.filter((item) => !paths.includes(item.path))
          }
        : prev
    )
    void run(key, async () => {
      const result = await window.vertragus.sessions.discardOrphanWorktrees(paths)
      if (result.failed > 0) throw new Error(describeDiscardFailure(t, result))
    })
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
    setConfirming(null)
    try {
      for (const session of status.resumableSessions) {
        await window.vertragus.sessions.restartAgents(session.profileId, session.id)
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      try {
        await refresh()
      } finally {
        setBusy(null)
      }
    }
  }

  /** First click arms the confirm; a second click on the same key runs the action. */
  const requestOrConfirm = (key: string, action: () => void): void => {
    const next = resolveConfirmClick(confirming, key)
    setConfirming(next.confirming)
    if (next.fire) action()
  }

  /**
   * Destructive action rendered with an in-banner two-click confirm — never
   * window.confirm, which is unreliable / blocked in many Electron renderers.
   * First click arms: the label flips to a short confirm prompt, the full
   * warning moves to the title tooltip, and a cancel button appears. A second
   * click on the same button runs the action.
   */
  const renderConfirmAction = (
    key: string,
    idleLabel: string,
    confirmTitle: string,
    action: () => void,
    options?: { armedLabel?: string; idleClass?: string }
  ): JSX.Element => {
    const armed = confirming === key
    const idleClass = options?.idleClass ?? 'btn ghost'
    return (
      <span className="restore-confirm">
        <button
          type="button"
          className={armed ? 'btn armed' : idleClass}
          disabled={busy != null}
          title={armed ? confirmTitle : undefined}
          aria-label={armed ? confirmTitle : undefined}
          onClick={() => requestOrConfirm(key, action)}
        >
          {busy === key
            ? t('restore.discarding')
            : armed
              ? (options?.armedLabel ?? t('restore.confirm'))
              : idleLabel}
        </button>
        {armed && (
          <button
            type="button"
            className="btn ghost"
            disabled={busy != null}
            onClick={() => setConfirming(null)}
          >
            {t('restore.cancel')}
          </button>
        )}
      </span>
    )
  }

  // Expand/collapse for the whole detail area: explicit per-launch choice wins,
  // otherwise small statuses (threshold) open directly.
  const isExpanded = expandedPref ?? shouldAutoExpand(status)
  const setExpanded = (next: boolean): void => {
    expandedForLaunch = next
    setExpandedPref(next)
  }
  const detailCount =
    status.resumableSessions.length + status.orphanedWorktrees.length + status.staleSessions.length
  const compactSummary = buildCompactSummary(status, t)
  const cleanupTargets = collectCleanupTargets(status)
  const cleanupCount = cleanupTargets.orphanPaths.length + cleanupTargets.staleSessions.length

  /** Bulk action: discard every orphaned worktree and dismiss all stale sessions. */
  const discardEverything = (): void => {
    const targets = cleanupTargets
    // Optimistically clear both groups so the banner shrinks immediately while
    // the main process finishes filesystem + git cleanup.
    setStatus((prev) => (prev ? { ...prev, orphanedWorktrees: [], staleSessions: [] } : prev))
    void run('discard-everything', async () => {
      const result = await runFullCleanup(
        {
          discardOrphanWorktrees: (paths) =>
            window.vertragus.sessions.discardOrphanWorktrees(paths),
          removeWorkspaceSession: (profileId, sessionId) =>
            window.vertragus.workspaceSessions.remove(profileId, sessionId)
        },
        targets
      )
      if (result.failed > 0) throw new Error(describeDiscardFailure(t, result))
    })
  }

  const busyDiscarding =
    busy != null &&
    (busy === 'discard-everything' ||
      busy === 'orphans-all' ||
      busy === 'orphans-clean' ||
      busy.startsWith('orphan-'))

  return (
    <div className="restore-banner" role="region" aria-label={t('restore.title')}>
      <div className="restore-head">
        <div className="restore-head-copy">
          {detailCount > 0 ? (
            <button
              type="button"
              className={`restore-toggle ${styles.summaryToggle}`}
              aria-expanded={isExpanded}
              onClick={() => setExpanded(!isExpanded)}
            >
              <span className="head">
                {status.cleanShutdown ? t('restore.title') : t('restore.titleCrash')}
              </span>
              <span className="rest">
                {busyDiscarding
                  ? t('restore.discarding')
                  : compactSummary || t('restore.summaryNone')}
              </span>
              <span className={styles.detailsHint}>
                {isExpanded ? t('restore.collapse') : t('restore.details')}
              </span>
              <span className="restore-chevron" aria-hidden>
                {isExpanded ? '▾' : '▸'}
              </span>
            </button>
          ) : (
            <span className="head">
              {status.cleanShutdown ? t('restore.title') : t('restore.titleCrash')}
            </span>
          )}
          {isExpanded && (
            <span className="rest">
              {status.restoredSessions > 0
                ? t('restore.summary', { count: status.restoredSessions })
                : t('restore.summaryNone')}
            </span>
          )}
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
          {cleanupCount > 0 &&
            renderConfirmAction(
              'discard-everything',
              t('restore.discardEverything'),
              t('restore.discardEverythingConfirm', {
                orphans: cleanupTargets.orphanPaths.length,
                stale: cleanupTargets.staleSessions.length
              }),
              discardEverything,
              {
                armedLabel: t('restore.discardEverythingArmed'),
                idleClass: `btn ${styles.dangerAction}`
              }
            )}
          <button
            type="button"
            className={status.resumableSessions.length > 0 ? 'btn ghost' : 'btn primary'}
            disabled={busy != null}
            onClick={() => {
              dismissedForLaunch = true
              setDismissed(true)
            }}
          >
            {status.resumableSessions.length > 0 ? t('restore.continue') : t('restore.continueClean')}
          </button>
        </div>
      </div>

      {error && <div className="restore-error">{error}</div>}

      {isExpanded && status.resumableSessions.length > 0 && (
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

      {isExpanded && status.orphanedWorktrees.length > 0 && (
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
              {cleanOrphans.length > 0 &&
                renderConfirmAction(
                  'orphans-clean',
                  t('restore.discardClean', { count: cleanOrphans.length }),
                  t('restore.discardCleanConfirm', { count: cleanOrphans.length }),
                  () => discardPaths('orphans-clean', cleanOrphans.map((item) => item.path))
                )}
              {renderConfirmAction(
                'orphans-all',
                t('restore.discardAll', { count: status.orphanedWorktrees.length }),
                t('restore.discardAllConfirm', {
                  count: status.orphanedWorktrees.length,
                  path: status.orphanedWorktrees[0]?.path ?? ''
                }),
                () =>
                  discardPaths(
                    'orphans-all',
                    status.orphanedWorktrees.map((item) => item.path)
                  )
              )}
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
                            {renderConfirmAction(
                              `orphan-${worktree.path}`,
                              t('restore.discard'),
                              t('restore.discardConfirm', { count: 1, path: worktree.path }),
                              () =>
                                void run(`orphan-${worktree.path}`, async () => {
                                  // The main process throws with the concrete
                                  // cause; `false` without one stays a fallback.
                                  const ok = await window.vertragus.sessions.discardOrphanWorktree(
                                    worktree.path
                                  )
                                  if (!ok) {
                                    throw new Error(
                                      t('restore.discardResult', { discarded: 0, failed: 1 })
                                    )
                                  }
                                })
                            )}
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

      {isExpanded && status.staleSessions.length > 0 && (
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
                  {renderConfirmAction(
                    `stale-${session.id}`,
                    t('restore.discard'),
                    t('restore.staleConfirm'),
                    () =>
                      void run(`stale-${session.id}`, () =>
                        window.vertragus.workspaceSessions.remove(session.profileId, session.id)
                      )
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
  )
}
