import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
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
  securityGateExcludes: [],
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
  it('rewrites worker-created commits into a centrally owned task commit', async () => {
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
    expect(result.change?.commit).not.toBe(workerCommit)
    expect(result.change?.commits).toEqual([result.change?.commit])
    expect(result.change?.files).toContain('feature.ts')
    expect(await git(dir, 'rev-parse', 'HEAD^')).toBe(base)
    expect(await git(dir, 'show', '-s', '--format=%s', 'HEAD')).toBe('orca(worker-1): Feature')
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


  it('keeps security-blocked file work in a central needs-work commit', async () => {
    const { dir, base } = await repo()
    const ipcDir = join(dir, 'src', 'main', 'ipc')
    await mkdir(ipcDir, { recursive: true })
    await writeFile(
      join(ipcDir, 'accounts.ts'),
      "import { ipcMain } from 'electron'\nipcMain.handle('account:read', (_event, id) => id)\n"
    )

    const result = await prepareTaskChange({
      config,
      commitOnly: true,
      baseCommit: base,
      taskId: 'worker-security',
      title: 'Sensitive IPC',
      worktree: dir
    })

    expect(result).toEqual(expect.objectContaining({
      result: 'needs-work',
      status: 'blocked',
      change: expect.objectContaining({ commit: expect.stringMatching(/^[0-9a-f]{40}$/) }),
      findings: [expect.objectContaining({ gate: 'security', code: 'missing-ipc-controls' })]
    }))
    expect(await git(dir, 'show', '-s', '--format=%s', 'HEAD')).toMatch(/needs work/)
    expect(await git(dir, 'rev-parse', 'HEAD^')).toBe(base)
  }, 20_000)

  it('rescues whitespace-dirty documentation as needs-work instead of blocking it', async () => {
    // Retro mrm3jl3a: Trailing Whitespace in Doku beendete den Lauf hart als error.
    const { dir, base } = await repo()
    await writeFile(join(dir, 'inventory.md'), '# Inventar \nZeile mit Trailing Space \n')

    const result = await prepareTaskChange({
      config,
      commitOnly: true,
      baseCommit: base,
      taskId: 'worker-docs',
      title: 'Doku-Inventar',
      worktree: dir
    })

    expect(result).toEqual(expect.objectContaining({
      result: 'needs-work',
      findings: expect.arrayContaining([
        expect.objectContaining({ gate: 'commit', code: 'whitespace' })
      ])
    }))
    expect(result.change?.files).toContain('inventory.md')
  }, 20_000)

  it('keeps worker scratch files out of the central commit and reports them', async () => {
    const { dir, base } = await repo()
    await writeFile(join(dir, 'feature.ts'), 'export const feature = true\n')
    await writeFile(join(dir, 'feature.ts.origcheck'), 'scratch\n')
    await writeFile(join(dir, '.verify-new-body-tmp.md'), 'scratch\n')

    const result = await prepareTaskChange({
      config,
      commitOnly: true,
      baseCommit: base,
      taskId: 'worker-scratch',
      title: 'Feature ohne Scratch',
      worktree: dir
    })

    expect(result.result).toBe('committed')
    expect(result.change?.files).toEqual(['feature.ts'])
    expect(result.findings).toEqual([
      expect.objectContaining({
        gate: 'commit',
        code: 'temp-files-removed',
        files: expect.arrayContaining(['feature.ts.origcheck', '.verify-new-body-tmp.md'])
      })
    ])
    const committedFiles = await git(dir, 'diff', '--name-only', `${base}..HEAD`)
    expect(committedFiles.trim()).toBe('feature.ts')
  }, 20_000)
})
