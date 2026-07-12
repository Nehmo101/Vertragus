import { describe, expect, it } from 'vitest'
import { worktreeIdentity } from './worktree'

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
