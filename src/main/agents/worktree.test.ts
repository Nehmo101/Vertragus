import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createWorktree, isOrcaBranch, isOrcaWorktreePath, worktreeIdentity } from './worktree'

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'orca-test',
  GIT_AUTHOR_EMAIL: 'orca@test',
  GIT_COMMITTER_NAME: 'orca-test',
  GIT_COMMITTER_EMAIL: 'orca@test'
}

function gitIn(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: GIT_ENV }).trim()
}

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

describe('createWorktree dependency base', () => {
  const created: string[] = []
  afterEach(() => {
    for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  function initRepo(): string {
    const root = mkdtempSync(join(tmpdir(), 'orca-wt-'))
    created.push(root)
    gitIn(root, ['init', '-q', '-b', 'main'])
    return root
  }

  it('branches a dependent worktree from the given base commit, not HEAD', async () => {
    const root = initRepo()
    writeFileSync(join(root, 'foundation.txt'), 'base\n')
    gitIn(root, ['add', '-A'])
    gitIn(root, ['commit', '-qm', 'foundation'])
    const foundation = gitIn(root, ['rev-parse', 'HEAD'])
    writeFileSync(join(root, 'later.txt'), 'later\n')
    gitIn(root, ['add', '-A'])
    gitIn(root, ['commit', '-qm', 'later'])

    const wt = await createWorktree(root, 'task-dep', 'session-x', foundation)
    expect(wt).not.toBeNull()
    expect(gitIn(wt!.path, ['rev-parse', 'HEAD'])).toBe(foundation)
    const tracked = gitIn(wt!.path, ['ls-files'])
    expect(tracked).toContain('foundation.txt')
    expect(tracked).not.toContain('later.txt')
  })

  it('falls back to HEAD when the base ref cannot be resolved', async () => {
    const root = initRepo()
    writeFileSync(join(root, 'a.txt'), 'a\n')
    gitIn(root, ['add', '-A'])
    gitIn(root, ['commit', '-qm', 'a'])
    const head = gitIn(root, ['rev-parse', 'HEAD'])

    const wt = await createWorktree(root, 'task-x', 'session-y', '0'.repeat(40))
    expect(wt).not.toBeNull()
    expect(gitIn(wt!.path, ['rev-parse', 'HEAD'])).toBe(head)
  })
})
