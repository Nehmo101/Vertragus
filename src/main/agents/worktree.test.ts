import { describe, expect, it } from 'vitest'
import { isOrcaBranch, isOrcaWorktreePath, worktreeIdentity } from './worktree'

describe('worktreeIdentity', () => {
  it('isolates identical agent ids across app sessions', () => {
    const first = worktreeIdentity('C:\\repo', 'task-01', 'session-a')
    const second = worktreeIdentity('C:\\repo', 'task-01', 'session-b')

    expect(first.branch).toBe('orca/session-a/task-01')
    expect(second.branch).toBe('orca/session-b/task-01')
    expect(first.path).not.toBe(second.path)
  })

  it('sanitizes display ids into safe branch segments', () => {
    const identity = worktreeIdentity('/repo', 'Task 01/Review', 'Session:ABC')

    expect(identity.branch).toBe('orca/session-abc/task-01-review')
    expect(identity.path).toContain('.orca-worktrees')
  })

  it('rejects identities that have no safe characters', () => {
    expect(() => worktreeIdentity('/repo', '///', 'session-a')).toThrow('Agent-ID')
  })
})

describe('rollback safety guards', () => {
  it('only accepts paths inside an .orca-worktrees tree', () => {
    expect(isOrcaWorktreePath('/repo/.orca-worktrees/session-a/task-01')).toBe(true)
    expect(isOrcaWorktreePath('C:\\repo\\.orca-worktrees\\session-a\\task-01')).toBe(true)
    expect(isOrcaWorktreePath('/repo')).toBe(false)
    expect(isOrcaWorktreePath('/repo/src/orca-worktrees-note')).toBe(false)
    expect(isOrcaWorktreePath('')).toBe(false)
  })

  it('only accepts branches in the orca/ namespace', () => {
    expect(isOrcaBranch('orca/session-a/task-01')).toBe(true)
    expect(isOrcaBranch('DEV')).toBe(false)
    expect(isOrcaBranch('feature/orca')).toBe(false)
    expect(isOrcaBranch('')).toBe(false)
  })
})
