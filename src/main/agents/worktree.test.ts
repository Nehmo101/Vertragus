import { describe, expect, it } from 'vitest'
import { isOrcaBranch, isOrcaWorktreePath, worktreeIdentity } from './worktree'

describe('worktreeIdentity', () => {
  it('isolates identical agent ids across app sessions', () => {
    const first = worktreeIdentity('C:\\repo', 'task-01', 'session-a')
    const second = worktreeIdentity('C:\\repo', 'task-01', 'session-b')

    expect(first.branch).toBe('vertragus/session-a/task-01')
    expect(second.branch).toBe('vertragus/session-b/task-01')
    expect(first.path).not.toBe(second.path)
  })

  it('creates new worktrees under the vertragus namespace', () => {
    const identity = worktreeIdentity('/repo', 'Task 01/Review', 'Session:ABC')

    expect(identity.branch).toBe('vertragus/session-abc/task-01-review')
    expect(identity.path).toContain('.vertragus-worktrees')
    // New checkouts never land in the legacy tree.
    expect(identity.path).not.toContain('.orca-worktrees')
  })

  it('rejects identities that have no safe characters', () => {
    expect(() => worktreeIdentity('/repo', '///', 'session-a')).toThrow('Agent-ID')
  })
})

describe('rollback safety guards', () => {
  it('accepts managed worktree trees (new + legacy) only', () => {
    expect(isOrcaWorktreePath('/repo/.vertragus-worktrees/session-a/task-01')).toBe(true)
    expect(isOrcaWorktreePath('C:\\repo\\.vertragus-worktrees\\session-a\\task-01')).toBe(true)
    // Legacy checkouts stay cleanable after the rebrand.
    expect(isOrcaWorktreePath('/repo/.orca-worktrees/session-a/task-01')).toBe(true)
    expect(isOrcaWorktreePath('C:\\repo\\.orca-worktrees\\session-a\\task-01')).toBe(true)
  })

  it('never treats non-managed paths as owned (no destructive false positive)', () => {
    expect(isOrcaWorktreePath('/repo')).toBe(false)
    // Look-alike segments without the leading dot must not be owned.
    expect(isOrcaWorktreePath('/repo/src/orca-worktrees-note')).toBe(false)
    expect(isOrcaWorktreePath('/repo/src/vertragus-worktrees-note')).toBe(false)
    expect(isOrcaWorktreePath('/home/user/my.vertragus-worktrees.bak')).toBe(false)
    expect(isOrcaWorktreePath('')).toBe(false)
  })

  it('accepts managed branch namespaces (new + legacy) only', () => {
    expect(isOrcaBranch('vertragus/session-a/task-01')).toBe(true)
    expect(isOrcaBranch('orca/session-a/task-01')).toBe(true)
  })

  it('never deletes user branches that merely mention the namespace', () => {
    expect(isOrcaBranch('DEV')).toBe(false)
    expect(isOrcaBranch('feature/orca')).toBe(false)
    expect(isOrcaBranch('feature/vertragus')).toBe(false)
    expect(isOrcaBranch('my-vertragus/x')).toBe(false)
    expect(isOrcaBranch('')).toBe(false)
  })
})
