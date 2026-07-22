import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import {
  createWorktree,
  discardManagedOrphans,
  inventoryWorktrees,
  isManagedBranch,
  isManagedWorktreePath,
  managedWorktreeParts,
  rollbackWorktree,
  worktreeIdentity
} from './worktree'

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'vertragus-test',
  GIT_AUTHOR_EMAIL: 'vertragus@test',
  GIT_COMMITTER_NAME: 'vertragus-test',
  GIT_COMMITTER_EMAIL: 'vertragus@test'
}

function gitIn(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: GIT_ENV }).trim()
}

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
    expect(isManagedWorktreePath('/repo/.vertragus-worktrees/session-a/task-01')).toBe(true)
    expect(isManagedWorktreePath('C:\\repo\\.vertragus-worktrees\\session-a\\task-01')).toBe(true)
    // Legacy checkouts stay cleanable after the rebrand.
    expect(isManagedWorktreePath('/repo/.orca-worktrees/session-a/task-01')).toBe(true)
    expect(isManagedWorktreePath('C:\\repo\\.orca-worktrees\\session-a\\task-01')).toBe(true)
  })

  it('never treats non-managed paths as owned (no destructive false positive)', () => {
    expect(isManagedWorktreePath('/repo')).toBe(false)
    // Look-alike segments without the leading dot must not be owned.
    expect(isManagedWorktreePath('/repo/src/orca-worktrees-note')).toBe(false)
    expect(isManagedWorktreePath('/repo/src/vertragus-worktrees-note')).toBe(false)
    expect(isManagedWorktreePath('/home/user/my.vertragus-worktrees.bak')).toBe(false)
    expect(isManagedWorktreePath('')).toBe(false)
  })

  it('accepts managed branch namespaces (new + legacy) only', () => {
    expect(isManagedBranch('vertragus/session-a/task-01')).toBe(true)
    expect(isManagedBranch('orca/session-a/task-01')).toBe(true)
  })

  it('never deletes user branches that merely mention the namespace', () => {
    expect(isManagedBranch('DEV')).toBe(false)
    expect(isManagedBranch('feature/orca')).toBe(false)
    expect(isManagedBranch('feature/vertragus')).toBe(false)
    expect(isManagedBranch('my-vertragus/x')).toBe(false)
    expect(isManagedBranch('')).toBe(false)
  })

  it('parses managed worktree paths into root + identity parts', () => {
    expect(managedWorktreeParts('/repo/.vertragus-worktrees/session-a/task-01')).toEqual({
      root: '/repo',
      legacy: false,
      sessionId: 'session-a',
      agentId: 'task-01'
    })
    expect(managedWorktreeParts('C:\\repo\\.orca-worktrees\\session-b\\codex-01')).toEqual({
      root: 'C:/repo',
      legacy: true,
      sessionId: 'session-b',
      agentId: 'codex-01'
    })
    expect(managedWorktreeParts('/repo/src')).toBeNull()
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

  it('discards broken leftover worktree directories that Git can no longer remove', async () => {
    const repo = initRepo()
    const orphan = join(repo, '.vertragus-worktrees', 'session-broken', 'codex-01')
    // Simulate a crash leftover: directory exists, but it is not a linked worktree.
    mkdirSync(orphan, { recursive: true })
    writeFileSync(join(orphan, 'wip.txt'), 'orphaned work')

    await expect(rollbackWorktree(orphan)).resolves.toBe(true)
    expect(existsSync(orphan)).toBe(false)
    // Empty session container should go away with the last agent checkout.
    expect(existsSync(join(repo, '.vertragus-worktrees', 'session-broken'))).toBe(false)

    const inventory = await inventoryWorktrees(repo, new Set())
    expect(inventory).toEqual([])
  })

  it('bulk-discards many unregistered leftovers without leaving ghosts', async () => {
    const repo = initRepo()
    const paths: string[] = []
    for (let session = 0; session < 5; session += 1) {
      for (let agent = 0; agent < 4; agent += 1) {
        const path = join(
          repo,
          '.vertragus-worktrees',
          `session-${session}`,
          `agent-${agent}`
        )
        mkdirSync(path, { recursive: true })
        writeFileSync(join(path, 'wip.txt'), `leftover ${session}/${agent}`)
        paths.push(path)
      }
    }
    // One owned session must be refused.
    const owned = join(repo, '.vertragus-worktrees', 'session-owned', 'agent-0')
    mkdirSync(owned, { recursive: true })
    paths.push(owned)

    const result = await discardManagedOrphans(paths, (sessionId) => sessionId === 'session-owned')
    expect(result).toEqual({ discarded: 20, failed: 1 })
    expect(existsSync(owned)).toBe(true)
    expect(await inventoryWorktrees(repo, new Set(['session-owned']))).toEqual([
      expect.objectContaining({ sessionId: 'session-owned', owned: true })
    ])
  })
})

describe('createWorktree dependency base', () => {
  const created: string[] = []
  afterEach(() => {
    for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  function initRepo(): string {
    const root = mkdtempSync(join(tmpdir(), 'vertragus-wt-'))
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
