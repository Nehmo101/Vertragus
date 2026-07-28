import { describe, expect, it, vi } from 'vitest'
import i18n from '../i18n'
import type {
  OrphanedWorktreeInfo,
  ResumableSessionInfo,
  SessionRestoreStatus,
  StaleSessionInfo
} from '@shared/sessions'
import {
  CONFIRM_RESET_MS,
  buildCompactSummary,
  collectCleanupTargets,
  describeDiscardFailure,
  groupOrphans,
  resolveConfirmClick,
  runFullCleanup,
  shouldAutoExpand
} from './SessionRestoreBanner'

// The summary test asserts the German source copy, independent of the host locale.
const t = i18n.getFixedT('de')

/**
 * This project has no @testing-library/react and vitest runs in `environment:
 * 'node'`, so these tests exercise the exported decision/action cores that the
 * banner component wires into its JSX (compact-vs-expanded threshold, summary
 * line, bulk cleanup, two-click confirm) plus a source contract for the wiring.
 */

function makeStatus(overrides: Partial<SessionRestoreStatus> = {}): SessionRestoreStatus {
  return {
    cleanShutdown: true,
    restoredSessions: 0,
    resumableSessions: [],
    orphanedWorktrees: [],
    staleSessions: [],
    ...overrides
  }
}

function orphan(path: string, changedFiles?: number, sessionId = 's1'): OrphanedWorktreeInfo {
  return { path, sessionId, agentId: `agent-${path}`, legacy: false, changedFiles }
}

function resumable(id: string): ResumableSessionInfo {
  return { id, profileId: 'p1', name: id, agentCount: 2, capturedAt: 0 }
}

function stale(id: string, profileId = 'p1'): StaleSessionInfo {
  return { id, profileId, name: id, updatedAt: 0 }
}

describe('shouldAutoExpand (kompakt vs. aufgeklappt)', () => {
  it('opens the detail view directly for a single small item', () => {
    expect(shouldAutoExpand(makeStatus({ resumableSessions: [resumable('a')] }))).toBe(true)
    expect(shouldAutoExpand(makeStatus({ orphanedWorktrees: [orphan('/w1')] }))).toBe(true)
    expect(shouldAutoExpand(makeStatus({ staleSessions: [stale('s')] }))).toBe(true)
  })

  it('opens directly when there is nothing to summarize (crash-only banner)', () => {
    expect(shouldAutoExpand(makeStatus({ cleanShutdown: false }))).toBe(true)
  })

  it('starts collapsed as soon as more than one item is pending', () => {
    expect(
      shouldAutoExpand(makeStatus({ resumableSessions: [resumable('a'), resumable('b')] }))
    ).toBe(false)
    expect(
      shouldAutoExpand(
        makeStatus({ resumableSessions: [resumable('a')], orphanedWorktrees: [orphan('/w1')] })
      )
    ).toBe(false)
    expect(
      shouldAutoExpand(
        makeStatus({ orphanedWorktrees: [orphan('/w1'), orphan('/w2'), orphan('/w3')] })
      )
    ).toBe(false)
  })
})

describe('buildCompactSummary', () => {
  it('joins all three groups with a middle dot and counts dirty orphans', () => {
    const status = makeStatus({
      resumableSessions: [resumable('a'), resumable('b')],
      orphanedWorktrees: [orphan('/w1', 3), orphan('/w2', 0), orphan('/w3', 1)],
      staleSessions: [stale('s1')]
    })
    expect(buildCompactSummary(status, t)).toBe(
      '2 Sessions wiederherstellbar · 3 verwaiste Worktrees (2 mit Änderungen) · 1 alte Session'
    )
  })

  it('uses singular forms and omits the dirty suffix for clean orphans', () => {
    expect(
      buildCompactSummary(
        makeStatus({ resumableSessions: [resumable('a')], orphanedWorktrees: [orphan('/w1', 0)] }),
        t
      )
    ).toBe('1 Session wiederherstellbar · 1 verwaister Worktree')
  })

  it('returns an empty string when there is nothing to count', () => {
    expect(buildCompactSummary(makeStatus({ cleanShutdown: false }), t)).toBe('')
  })
})

describe('collectCleanupTargets', () => {
  it('collects every orphan path and every stale session id/profile pair', () => {
    const status = makeStatus({
      orphanedWorktrees: [orphan('/w1', 2), orphan('/w2', 0)],
      staleSessions: [stale('s1', 'p1'), stale('s2', 'p2')]
    })
    expect(collectCleanupTargets(status)).toEqual({
      orphanPaths: ['/w1', '/w2'],
      staleSessions: [
        { id: 's1', profileId: 'p1' },
        { id: 's2', profileId: 'p2' }
      ]
    })
  })
})

describe('runFullCleanup (Sammelaktion)', () => {
  it('discards all orphans in one call and dismisses every stale session', async () => {
    const discardOrphanWorktrees = vi
      .fn()
      .mockResolvedValue({ discarded: 2, failed: 0, failures: [] })
    const removeWorkspaceSession = vi.fn().mockResolvedValue([])

    const result = await runFullCleanup(
      { discardOrphanWorktrees, removeWorkspaceSession },
      {
        orphanPaths: ['/w1', '/w2'],
        staleSessions: [
          { id: 's1', profileId: 'p1' },
          { id: 's2', profileId: 'p2' }
        ]
      }
    )

    expect(discardOrphanWorktrees).toHaveBeenCalledTimes(1)
    expect(discardOrphanWorktrees).toHaveBeenCalledWith(['/w1', '/w2'])
    expect(removeWorkspaceSession).toHaveBeenCalledTimes(2)
    expect(removeWorkspaceSession).toHaveBeenNthCalledWith(1, 'p1', 's1')
    expect(removeWorkspaceSession).toHaveBeenNthCalledWith(2, 'p2', 's2')
    expect(result).toEqual({ discarded: 4, failed: 0, failures: [] })
  })

  it('skips the orphan IPC call entirely when there are no orphans', async () => {
    const discardOrphanWorktrees = vi.fn()
    const removeWorkspaceSession = vi.fn().mockResolvedValue([])

    const result = await runFullCleanup(
      { discardOrphanWorktrees, removeWorkspaceSession },
      { orphanPaths: [], staleSessions: [{ id: 's1', profileId: 'p1' }] }
    )

    expect(discardOrphanWorktrees).not.toHaveBeenCalled()
    expect(result).toEqual({ discarded: 1, failed: 0, failures: [] })
  })

  it('aggregates orphan failures and counts stale rejections without aborting', async () => {
    const discardOrphanWorktrees = vi.fn().mockResolvedValue({
      discarded: 1,
      failed: 1,
      failures: [{ path: '/w2', reason: 'EPERM: operation not permitted' }]
    })
    const removeWorkspaceSession = vi
      .fn()
      .mockRejectedValueOnce(new Error('locked'))
      .mockResolvedValueOnce([])

    const result = await runFullCleanup(
      { discardOrphanWorktrees, removeWorkspaceSession },
      {
        orphanPaths: ['/w1', '/w2'],
        staleSessions: [
          { id: 's1', profileId: 'p1' },
          { id: 's2', profileId: 'p1' }
        ]
      }
    )

    // The second stale session is still dismissed after the first one failed.
    expect(removeWorkspaceSession).toHaveBeenCalledTimes(2)
    expect(result).toEqual({
      discarded: 2,
      failed: 2,
      failures: [
        { path: '/w2', reason: 'EPERM: operation not permitted' },
        { path: 's1', reason: 'locked' }
      ]
    })
  })
})

describe('describeDiscardFailure (Ursachen statt bloßer Zahl)', () => {
  it('names the dominant cause with an example path', () => {
    const message = describeDiscardFailure(t, {
      discarded: 0,
      failed: 3,
      failures: [
        { path: 'C:\\git\\uwe\\.vertragus-worktrees\\s1\\a1', reason: 'EPERM: not permitted' },
        { path: 'C:\\git\\uwe\\.vertragus-worktrees\\s1\\a2', reason: 'EPERM: not permitted' },
        { path: 'C:\\git\\uwe\\.vertragus-worktrees\\s2\\a1', reason: 'EPERM: not permitted' }
      ]
    })

    expect(message).toContain('0 verworfen, 3 fehlgeschlagen.')
    expect(message).toContain('3× EPERM: not permitted')
    expect(message).toContain('C:\\git\\uwe\\.vertragus-worktrees\\s1\\a1')
  })

  it('ranks causes and summarizes the tail', () => {
    const message = describeDiscardFailure(t, {
      discarded: 1,
      failed: 4,
      failures: [
        { path: '/a', reason: 'EBUSY' },
        { path: '/b', reason: 'EPERM' },
        { path: '/c', reason: 'EPERM' },
        { path: '/d', reason: 'Gehört zu einer bekannten Session.' }
      ]
    })

    expect(message.indexOf('2× EPERM')).toBeLessThan(message.indexOf('1× EBUSY'))
    expect(message).toContain('+ 1 weitere Ursache(n)')
    expect(message).not.toContain('Gehört zu einer bekannten Session.')
  })

  it('falls back to the plain count when no reason was reported', () => {
    expect(describeDiscardFailure(t, { discarded: 2, failed: 0, failures: [] })).toBe(
      '2 verworfen, 0 fehlgeschlagen.'
    )
  })
})

describe('resolveConfirmClick (Zwei-Klick-Confirm)', () => {
  it('arms on the first click without firing', () => {
    expect(resolveConfirmClick(null, 'discard-everything')).toEqual({
      confirming: 'discard-everything',
      fire: false
    })
  })

  it('fires and disarms on the second click on the same key', () => {
    expect(resolveConfirmClick('discard-everything', 'discard-everything')).toEqual({
      confirming: null,
      fire: true
    })
  })

  it('re-arms instead of firing when a different key is clicked', () => {
    expect(resolveConfirmClick('orphans-all', 'discard-everything')).toEqual({
      confirming: 'discard-everything',
      fire: false
    })
  })

  it('exposes a sane auto-disarm timeout', () => {
    expect(CONFIRM_RESET_MS).toBeGreaterThanOrEqual(3000)
  })
})

describe('groupOrphans', () => {
  it('groups by session, counts dirty items and sorts larger groups first', () => {
    const groups = groupOrphans([
      orphan('/a1', 0, 'sB'),
      orphan('/b1', 2, 'sA'),
      orphan('/b2', undefined, 'sA')
    ])
    expect(groups.map((group) => group.sessionId)).toEqual(['sA', 'sB'])
    expect(groups[0]).toMatchObject({ dirtyCount: 1 })
    expect(groups[1]).toMatchObject({ dirtyCount: 0 })
  })
})

describe('SessionRestoreBanner source contract (wiring)', () => {
  it('keeps the summary row an aria-expanded toggle and gates details on isExpanded', async () => {
    const source = await import('./SessionRestoreBanner.tsx?raw').then(
      (module) => module.default as string
    )
    // Compact row is a real button with aria-expanded.
    expect(source).toMatch(/aria-expanded=\{isExpanded\}/)
    // All three detail sections only render when expanded.
    expect(source).toMatch(/isExpanded && status\.resumableSessions\.length > 0/)
    expect(source).toMatch(/isExpanded && status\.orphanedWorktrees\.length > 0/)
    expect(source).toMatch(/isExpanded && status\.staleSessions\.length > 0/)
    // Expand state is per launch only (module flag), never persisted to a store.
    expect(source).toMatch(/let expandedForLaunch/)
    expect(source).not.toMatch(/localStorage|electron-store/)
    // Bulk action reuses the existing IPC surface and the two-click confirm.
    expect(source).toMatch(/renderConfirmAction\(\s*'discard-everything'/)
    expect(source).toMatch(/window\.vertragus\.sessions\.discardOrphanWorktrees\(paths\)/)
    expect(source).toMatch(/window\.vertragus\.workspaceSessions\.remove\(profileId, sessionId\)/)
    // Armed confirms auto-disarm via the shared timeout.
    expect(source).toMatch(/setTimeout\(\(\) => setConfirming\(null\), CONFIRM_RESET_MS\)/)
  })
})
