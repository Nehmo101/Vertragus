import { execFile } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  branchExists,
  createWorktree,
  listWorktrees,
  removeWorktree,
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

  it('starts the branch from a given startPoint instead of HEAD', async () => {
    // A base branch with a commit HEAD does not have — the worktree must see it.
    await git(['checkout', '-b', 'vertragus/paradiso/worker-base'])
    writeFileSync(join(repoPath, 'handoff.txt'), 'from the worker\n')
    await git(['add', 'handoff.txt'])
    await git(['commit', '-m', 'worker result'])
    await git(['checkout', 'main'])

    const created = await createWorktree(repoPath, 'agent-chained', 'vertragus/paradiso/reviewer', {
      startPoint: 'vertragus/paradiso/worker-base'
    })

    expect(existsSync(join(created.path, 'handoff.txt'))).toBe(true)
    // HEAD of the main checkout never had that file.
    expect(existsSync(join(repoPath, 'handoff.txt'))).toBe(false)
  }, 30_000)

  it('passes the startPoint as the final git argument', async () => {
    const git = vi.fn(async (args: string[]) => {
      if (args[0] === 'rev-parse') throw new Error('no such ref')
      return { stdout: '', stderr: '' }
    })
    const fakeRepo = mkdtempSync(join(tmpdir(), 'vg-startpoint-'))
    try {
      await createWorktree(fakeRepo, 'agent-four', 'vertragus/a/c', { git, startPoint: 'base' })
      const addCall = git.mock.calls.find((call) => call[0][1] === 'add')
      expect(addCall?.[0]).toEqual([
        'worktree',
        'add',
        join(fakeRepo, WORKTREE_ROOT, 'agent-four'),
        '-b',
        'vertragus/a/c',
        'base'
      ])
    } finally {
      rmSync(fakeRepo, { recursive: true, force: true })
    }
  })

  it('makes .vertragus self-ignoring so the worktrees never pollute git status', async () => {
    await createWorktree(repoPath, 'agent-ignore', 'vertragus/paradiso/ignaro')

    expect(readFileSync(join(repoPath, '.vertragus', '.gitignore'), 'utf8')).toBe('*\n')
    // The proof is git's own view: nothing under .vertragus shows up untracked.
    const { stdout } = await execFileAsync('git', ['status', '--porcelain'], {
      cwd: repoPath,
      windowsHide: true
    })
    expect(stdout).not.toContain('.vertragus')
  }, 30_000)

  it('leaves an existing .vertragus/.gitignore alone', async () => {
    const ignorePath = join(repoPath, '.vertragus', '.gitignore')
    writeFileSync(ignorePath, '# user-edited\nworktrees/\n')
    await createWorktree(repoPath, 'agent-keep', 'vertragus/paradiso/custode')
    expect(readFileSync(ignorePath, 'utf8')).toBe('# user-edited\nworktrees/\n')
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
    // A real tmp path: createWorktree mkdirs the parent even with an injected
    // git runner, and an absolute '/repo' lands in the filesystem root on
    // POSIX CI runners (EACCES).
    const fakeRepo = mkdtempSync(join(tmpdir(), 'vg-shellstring-'))
    try {
      await createWorktree(fakeRepo, 'agent-three', 'vertragus/a/b', { git })

      const addCall = git.mock.calls.find((call) => call[0][1] === 'add')
      expect(addCall?.[0]).toEqual([
        'worktree',
        'add',
        join(fakeRepo, WORKTREE_ROOT, 'agent-three'),
        '-b',
        'vertragus/a/b'
      ])
    } finally {
      rmSync(fakeRepo, { recursive: true, force: true })
    }
  })
})

describe('removeWorktree', () => {
  it('removes a clean worktree but keeps its branch', async () => {
    const created = await createWorktree(repoPath, 'agent-gone', 'vertragus/paradiso/passato')

    await removeWorktree(repoPath, created.path)

    expect(existsSync(created.path)).toBe(false)
    const paths = (await listWorktrees(repoPath)).map((entry) => entry.path.replace(/\\/g, '/'))
    expect(paths.some((path) => path.endsWith('agent-gone'))).toBe(false)
    // The branch survives — committed work stays reachable after cleanup.
    expect(await branchExists(repoPath, created.branch)).toBe(true)
  }, 30_000)

  it('refuses a dirty worktree instead of discarding uncommitted changes', async () => {
    const created = await createWorktree(repoPath, 'agent-dirty', 'vertragus/paradiso/sporco')
    writeFileSync(join(created.path, 'wip.txt'), 'not committed\n')

    await expect(removeWorktree(repoPath, created.path)).rejects.toThrow(
      /git worktree remove failed/
    )
    expect(existsSync(join(created.path, 'wip.txt'))).toBe(true)
  }, 30_000)

  it('never builds a shell string — git is called with an argument array', async () => {
    const git = vi.fn(async () => ({ stdout: '', stderr: '' }))
    await removeWorktree('/repo', '/repo/.vertragus/worktrees/a1', { git })
    expect(git).toHaveBeenCalledWith(
      ['worktree', 'remove', '/repo/.vertragus/worktrees/a1'],
      '/repo'
    )
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
