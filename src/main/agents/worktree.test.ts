import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  createWorktree,
  inventoryWorktrees,
  isOrcaBranch,
  isOrcaWorktreePath,
  worktreeIdentity
} from './worktree'

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

describe('createWorktree + inventory against a real repository', () => {
  const repos: string[] = []

  function initRepo(): string {
    const repo = mkdtempSync(join(tmpdir(), 'vertragus-worktree-'))
    repos.push(repo)
    const git = (...args: string[]): void => {
      execFileSync('git', ['-C', repo, ...args], { stdio: 'ignore' })
    }
    git('init')
    git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid',
      'commit', '--allow-empty', '-m', 'init')
    return repo
  }

  afterAll(() => {
    while (repos.length > 0) rmSync(repos.pop()!, { recursive: true, force: true })
  })

  it('skips occupied identities after a restart instead of failing or reusing them', async () => {
    const repo = initRepo()

    const first = await createWorktree(repo, 'codex-01', 'session-stable')
    expect(first?.branch).toBe('vertragus/session-stable/codex-01')

    // Same session id + same agent id (restarted app, reset sequence): the
    // existing checkout must stay untouched and the new agent gets a free slot.
    const second = await createWorktree(repo, 'codex-01', 'session-stable')
    expect(second?.branch).toBe('vertragus/session-stable/codex-01-r2')
    expect(second?.path).not.toBe(first?.path)
  })

  it('classifies worktrees as owned or orphaned and reports uncommitted changes', async () => {
    const repo = initRepo()
    const kept = await createWorktree(repo, 'codex-01', 'session-kept')
    await createWorktree(repo, 'codex-01', 'session-gone')
    writeFileSync(join(kept!.path, 'wip.txt'), 'uncommitted work')

    const inventory = await inventoryWorktrees(repo, new Set(['session-kept']))

    expect(inventory).toHaveLength(2)
    const owned = inventory.find((entry) => entry.sessionId === 'session-kept')
    const orphaned = inventory.find((entry) => entry.sessionId === 'session-gone')
    expect(owned).toMatchObject({ owned: true, legacy: false, changedFiles: 1 })
    expect(orphaned).toMatchObject({ owned: false, changedFiles: 0 })
  })

  it('returns an empty inventory for a directory that is no git repository', async () => {
    const plain = mkdtempSync(join(tmpdir(), 'vertragus-plain-'))
    repos.push(plain)
    await expect(inventoryWorktrees(plain, new Set())).resolves.toEqual([])
  })
})
