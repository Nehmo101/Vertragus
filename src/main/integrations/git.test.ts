import { mkdtemp, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { gitInfo, parseWorktreePorcelain, switchBranch } from './git'
import { GitTestHarness } from './gitTestHarness'

const gitHarness = new GitTestHarness()

async function git(cwd: string, ...args: string[]): Promise<void> {
  await gitHarness.git(cwd, '-C', cwd, ...args)
}

describe('workspace branch selection', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'orca-git-'))
    await git(dir, 'init')
    await git(dir, 'config', 'user.email', 'test@orca.local')
    await git(dir, 'config', 'user.name', 'Orca Test')
    await writeFile(join(dir, 'README.md'), '# test\n', 'utf8')
    await git(dir, 'add', 'README.md')
    await git(dir, 'commit', '-m', 'initial')
    await git(dir, 'branch', '-M', 'main')
    await git(dir, 'branch', 'feature/test')
  })

  afterEach(async () => {
    await gitHarness.cleanup([dir])
  }, 20_000)

  it('lists local branches and switches the real checkout', async () => {
    const before = await gitInfo(dir)
    const canonicalDir = (await realpath(dir)).replace(/\\/g, '/')
    expect(before.branch).toBe('main')
    expect(before.branches).toEqual(['feature/test', 'main'])
    expect(before.worktrees).toEqual([
      expect.objectContaining({ path: canonicalDir, branch: 'main', detached: false, bare: false })
    ])

    const after = await switchBranch(dir, 'feature/test')

    expect(after.branch).toBe('feature/test')
    expect(after.branches).toEqual(['feature/test', 'main'])
  }, 20_000)

  it('parses detached, locked, and prunable worktree records', () => {
    expect(parseWorktreePorcelain(`worktree C:/repo
HEAD 1111111111111111111111111111111111111111
branch refs/heads/main

worktree C:/repo/.vertragus-worktrees/session/sub-01
HEAD 2222222222222222222222222222222222222222
detached
locked cleanup pending
prunable
`)).toEqual([
      {
        path: 'C:/repo',
        head: '1111111111111111111111111111111111111111',
        branch: 'main',
        detached: false,
        bare: false
      },
      {
        path: 'C:/repo/.vertragus-worktrees/session/sub-01',
        head: '2222222222222222222222222222222222222222',
        detached: true,
        bare: false,
        locked: 'cleanup pending',
        prunable: 'entfernbar'
      }
    ])
  })

  it('rejects names that are not local branches', async () => {
    await expect(switchBranch(dir, '--detach')).rejects.toThrow('Lokaler Branch nicht gefunden')
    expect((await gitInfo(dir)).branch).toBe('main')
  }, 20_000)
})
