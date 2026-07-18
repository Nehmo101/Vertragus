import { describe, expect, it } from 'vitest'
import { isManagedBranch, isManagedWorktreePath, worktreeIdentity } from './worktree'

describe('worktreeIdentity', () => {
  it('isolates identical agent ids across app sessions', () => {
    const first = worktreeIdentity('C:\\repo', 'task-01', 'session-a')
    const second = worktreeIdentity('C:\\repo', 'task-01', 'session-b')

    expect(first.branch).toBe('vertragus/session-a/task-01')
    expect(second.branch).toBe('vertragus/session-b/task-01')
    expect(first.path).not.toBe(second.path)
  })

  it('sanitizes display ids into safe branch segments', () => {
    const identity = worktreeIdentity('/repo', 'Task 01/Review', 'Session:ABC')

    expect(identity.branch).toBe('vertragus/session-abc/task-01-review')
    expect(identity.path).toContain('.vertragus-worktrees')
  })

  it('creates new worktrees under the current namespace, never the legacy one', () => {
    const identity = worktreeIdentity('/repo', 'task-01', 'session-a')

    expect(identity.path).not.toContain('.orca-worktrees')
    expect(identity.branch.startsWith('orca/')).toBe(false)
  })

  it('rejects identities that have no safe characters', () => {
    expect(() => worktreeIdentity('/repo', '///', 'session-a')).toThrow('Agent-ID')
  })
})

describe('rollback safety guards', () => {
  it('accepts paths inside the current .vertragus-worktrees tree', () => {
    expect(isManagedWorktreePath('/repo/.vertragus-worktrees/session-a/task-01')).toBe(true)
    expect(isManagedWorktreePath('C:\\repo\\.vertragus-worktrees\\session-a\\task-01')).toBe(true)
  })

  it('still accepts legacy .orca-worktrees paths so pre-existing runs stay cleanable', () => {
    expect(isManagedWorktreePath('/repo/.orca-worktrees/session-a/task-01')).toBe(true)
    expect(isManagedWorktreePath('C:\\repo\\.orca-worktrees\\session-a\\task-01')).toBe(true)
  })

  it('rejects paths that are not inside a managed worktree tree', () => {
    expect(isManagedWorktreePath('/repo')).toBe(false)
    expect(isManagedWorktreePath('/repo/src/orca-worktrees-note')).toBe(false)
    expect(isManagedWorktreePath('/repo/src/vertragus-worktrees-note')).toBe(false)
    expect(isManagedWorktreePath('')).toBe(false)
  })

  it('accepts branches in the current vertragus/ namespace', () => {
    expect(isManagedBranch('vertragus/session-a/task-01')).toBe(true)
  })

  it('still accepts legacy orca/ branches for cleanup of pre-existing runs', () => {
    expect(isManagedBranch('orca/session-a/task-01')).toBe(true)
  })

  it('rejects branches outside the managed namespaces', () => {
    expect(isManagedBranch('DEV')).toBe(false)
    expect(isManagedBranch('feature/orca')).toBe(false)
    expect(isManagedBranch('feature/vertragus')).toBe(false)
    expect(isManagedBranch('')).toBe(false)
  })
})
