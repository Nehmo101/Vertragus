import { execFile } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  branchExists,
  createWorktree,
  listWorktrees,
  slugifyRef,
  uniqueBranchName,
  worktreeBranchName,
  worktreePathFor,
  WORKTREE_ROOT
} from './worktree'

const execFileAsync = promisify(execFile)

/**
 * A real repository, not a mock: `git worktree add` is exactly the kind of call
 * whose flags and failure modes a stub would happily get wrong.
 */
let repoPath: string

async function git(args: string[], cwd = repoPath): Promise<void> {
  await execFileAsync('git', args, { cwd, windowsHide: true })
}

beforeAll(async () => {
  repoPath = mkdtempSync(join(tmpdir(), 'vertragus-worktree-'))
  await git(['init', '-b', 'main'])
  await git(['config', 'user.email', 'test@vertragus.local'])
  await git(['config', 'user.name', 'Vertragus Test'])
  await git(['config', 'commit.gpgsign', 'false'])
  writeFileSync(join(repoPath, 'README.md'), '# fixture\n')
  await git(['add', '.'])
  await git(['commit', '-m', 'fixture'])
}, 60_000)

afterAll(() => {
  if (repoPath) rmSync(repoPath, { recursive: true, force: true })
})

describe('naming', () => {
  it('builds a ref-safe branch name from workspace and agent', () => {
    expect(worktreeBranchName('Paradiso II', 'Caronte')).toBe('vertragus/paradiso-ii/caronte')
  })

  it('strips everything git would refuse in a ref', () => {
    expect(slugifyRef('Scala d’Oro')).toBe('scala-d-oro')
    expect(slugifyRef('Eunoe`~^:?*[')).toBe('eunoe')
    expect(slugifyRef('..lock..')).toBe('lock')
    expect(slugifyRef('   ')).toBe('x')
    expect(slugifyRef('   ', 'agent')).toBe('agent')
  })

  it('puts worktrees inside the repository, under .vertragus/worktrees', () => {
    expect(worktreePathFor('/repo', 'abc-123')).toBe(join('/repo', WORKTREE_ROOT, 'abc-123'))
  })
})

describe('createWorktree', () => {
  it('creates a checkout on a new branch and lists it', async () => {
    const created = await createWorktree(repoPath, 'agent-one', 'vertragus/paradiso/caronte')

    expect(created.branch).toBe('vertragus/paradiso/caronte')
    expect(created.path).toBe(join(repoPath, WORKTREE_ROOT, 'agent-one'))
    expect(existsSync(join(created.path, 'README.md'))).toBe(true)
    expect(await branchExists(repoPath, created.branch)).toBe(true)

    const worktrees = await listWorktrees(repoPath)
    const entry = worktrees.find((candidate) => candidate.path.replace(/\\/g, '/').endsWith('agent-one'))
    expect(entry?.branch).toBe('vertragus/paradiso/caronte')
    // The main checkout is always in the list too.
    expect(worktrees.length).toBeGreaterThanOrEqual(2)
  }, 30_000)

  it('does not collide with the branch a previous run left behind', async () => {
    // Branches deliberately survive their worktree — Vertragus never deletes work.
    const created = await createWorktree(repoPath, 'agent-two', 'vertragus/paradiso/caronte')
    expect(created.branch).toBe('vertragus/paradiso/caronte-2')
    expect(await branchExists(repoPath, 'vertragus/paradiso/caronte-2')).toBe(true)
  }, 30_000)

  it('reports git stderr instead of a bare exit code', async () => {
    const notARepo = mkdtempSync(join(tmpdir(), 'vertragus-norepo-'))
    try {
      await expect(createWorktree(notARepo, 'agent-x', 'vertragus/x/y')).rejects.toThrow(
        /git worktree add failed for agent agent-x/
      )
    } finally {
      rmSync(notARepo, { recursive: true, force: true })
    }
  }, 30_000)

  it('never builds a shell string — git is called with an argument array', async () => {
    const git = vi.fn(async (args: string[]) => {
      if (args[0] === 'rev-parse') throw new Error('no such ref')
      return { stdout: '', stderr: '' }
    })
    await createWorktree('/repo', 'agent-three', 'vertragus/a/b', { git })

    const addCall = git.mock.calls.find((call) => call[0][1] === 'add')
    expect(addCall?.[0]).toEqual([
      'worktree',
      'add',
      join('/repo', WORKTREE_ROOT, 'agent-three'),
      '-b',
      'vertragus/a/b'
    ])
  })
})

describe('uniqueBranchName', () => {
  it('walks -2, -3, … until a free name is found', async () => {
    const taken = new Set(['b', 'b-2', 'b-3'])
    const git = vi.fn(async (args: string[]) => {
      const ref = args[3]?.replace('refs/heads/', '')
      if (ref && taken.has(ref)) return { stdout: 'sha', stderr: '' }
      throw new Error('no such ref')
    })
    expect(await uniqueBranchName('/repo', 'b', { git })).toBe('b-4')
  })
})

describe('listWorktrees', () => {
  it('parses the porcelain format including detached heads', async () => {
    const git = vi.fn(async () => ({
      stdout: [
        'worktree /repo',
        'HEAD 1111111111111111111111111111111111111111',
        'branch refs/heads/main',
        '',
        'worktree /repo/.vertragus/worktrees/a1',
        'HEAD 2222222222222222222222222222222222222222',
        'detached',
        ''
      ].join('\n'),
      stderr: ''
    }))

    expect(await listWorktrees('/repo', { git })).toEqual([
      { path: '/repo', head: '1'.repeat(40), branch: 'main', detached: false },
      { path: '/repo/.vertragus/worktrees/a1', head: '2'.repeat(40), detached: true }
    ])
  })
})
