import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AutoPrConfig } from '@shared/profile'
import { prepareTaskChange } from './autoPr'
import { GitTestHarness } from './gitTestHarness'

const gitHarness = new GitTestHarness()
const created: string[] = []
const config: AutoPrConfig = {
  mode: 'off',
  strategy: 'aggregate',
  baseBranch: '',
  qualityGates: [],
  labels: [],
  reviewers: []
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  return gitHarness.git(cwd, ...args)
}

async function repo(): Promise<{ dir: string; base: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'orca-contract-'))
  created.push(dir)
  await git(dir, 'init')
  await git(dir, 'config', 'user.name', 'Orca Test')
  await git(dir, 'config', 'user.email', 'orca@example.invalid')
  await writeFile(join(dir, 'README.md'), 'base\n')
  await git(dir, 'add', '--all')
  await git(dir, 'commit', '-m', 'base')
  return { dir, base: await git(dir, 'rev-parse', 'HEAD') }
}

afterEach(async () => {
  await gitHarness.cleanup(created.splice(0))
}, 20_000)

describe('Auto-PR worker commit contract', () => {
  it('captures commits the worker created before returning', async () => {
    const { dir, base } = await repo()
    await writeFile(join(dir, 'feature.ts'), 'export const feature = true\n')
    await git(dir, 'add', '--all')
    await git(dir, 'commit', '-m', 'worker commit')
    const workerCommit = await git(dir, 'rev-parse', 'HEAD')

    const result = await prepareTaskChange({
      config,
      commitOnly: true,
      baseCommit: base,
      taskId: 'worker-1',
      title: 'Feature',
      worktree: dir
    })

    expect(result.result).toBe('committed')
    expect(result.change?.commit).toBe(workerCommit)
    expect(result.change?.commits).toEqual([workerCommit])
    expect(result.change?.files).toContain('feature.ts')
  }, 20_000)

  it('returns explicit no-changes when HEAD and worktree match the captured base', async () => {
    const { dir, base } = await repo()
    const result = await prepareTaskChange({
      config,
      commitOnly: true,
      baseCommit: base,
      taskId: 'worker-2',
      title: 'Inspection only',
      worktree: dir
    })
    expect(result).toEqual(expect.objectContaining({ result: 'no-changes', noChanges: true }))
  }, 20_000)
})
