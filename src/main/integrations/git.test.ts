import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { gitInfo, switchBranch } from './git'
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
    expect(before.branch).toBe('main')
    expect(before.branches).toEqual(['feature/test', 'main'])

    const after = await switchBranch(dir, 'feature/test')

    expect(after.branch).toBe('feature/test')
    expect(after.branches).toEqual(['feature/test', 'main'])
  }, 20_000)

  it('rejects names that are not local branches', async () => {
    await expect(switchBranch(dir, '--detach')).rejects.toThrow('Lokaler Branch nicht gefunden')
    expect((await gitInfo(dir)).branch).toBe('main')
  }, 20_000)
})
