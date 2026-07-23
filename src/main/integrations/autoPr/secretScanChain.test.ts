import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AutoPrConfig } from '@shared/profile'

const gitleaksMocks = vi.hoisted(() => ({ scanStagedWithGitleaks: vi.fn() }))

vi.mock('./gitleaksGate', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./gitleaksGate')>()
  return { ...actual, scanStagedWithGitleaks: gitleaksMocks.scanStagedWithGitleaks }
})

import { prepareTaskChange } from '../autoPr'
import { GitTestHarness } from '../gitTestHarness'
import { assertSecretScanGates } from './gates'

const gitHarness = new GitTestHarness()
const created: string[] = []

const baseConfig: AutoPrConfig = {
  mode: 'off',
  strategy: 'aggregate',
  baseBranch: '',
  qualityGates: [],
  securityGateExcludes: [],
  labels: [],
  reviewers: []
}

// Assembled from fragments so this test file never contains a secret-shaped literal.
const fakeAwsKey = `AKIA${'A'.repeat(16)}`

async function git(cwd: string, ...args: string[]): Promise<string> {
  return gitHarness.git(cwd, ...args)
}

async function repo(): Promise<{ dir: string; base: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'vertragus-secretscan-'))
  created.push(dir)
  await git(dir, 'init')
  await git(dir, 'config', 'user.name', 'Vertragus Test')
  await git(dir, 'config', 'user.email', 'orca@example.invalid')
  await writeFile(join(dir, 'README.md'), 'base\n')
  await git(dir, 'add', '--all')
  await git(dir, 'commit', '-m', 'base')
  return { dir, base: await git(dir, 'rev-parse', 'HEAD') }
}

beforeEach(() => {
  gitleaksMocks.scanStagedWithGitleaks.mockReset()
  gitleaksMocks.scanStagedWithGitleaks.mockResolvedValue({ status: 'clean' })
})

afterEach(async () => {
  await gitHarness.cleanup(created.splice(0))
}, 20_000)

describe('Auto-PR secret scan chain', () => {
  it("merges builtin and gitleaks findings for 'both' and commits nothing", async () => {
    const { dir, base } = await repo()
    await writeFile(join(dir, 'deploy.ts'), `export const deployKey = '${fakeAwsKey}'\n`)
    gitleaksMocks.scanStagedWithGitleaks.mockResolvedValue({
      status: 'findings',
      findings: [
        { file: 'deploy.ts', line: 1, rule: 'aws-access-key-id', redactedMatch: 'AWS Access Key' }
      ]
    })

    const result = await prepareTaskChange({
      config: { ...baseConfig, secretScanner: 'both' },
      commitOnly: true,
      baseCommit: base,
      taskId: 'secret-both',
      title: 'Beide Scanner',
      worktree: dir
    })

    expect(result).toEqual(expect.objectContaining({ status: 'blocked', result: 'blocked' }))
    expect(result.message).toMatch(/Moegliches Secret/)
    expect(result.message).toMatch(/gitleaks hat 1 potenzielle/)
    expect(result.message).toContain('deploy.ts:1 [aws-access-key-id]')
    // Redaction negative test: the blocked report itself must not leak the key.
    expect(result.message).not.toContain(fakeAwsKey)
    // Secrets get no needs-work rescue commit: HEAD must still be the base.
    expect(await git(dir, 'rev-parse', 'HEAD')).toBe(base)
    expect(gitleaksMocks.scanStagedWithGitleaks).toHaveBeenCalledWith(dir)
  }, 20_000)

  it('blocks clearly when gitleaks is configured but not installed', async () => {
    const { dir, base } = await repo()
    await writeFile(join(dir, 'feature.ts'), 'export const feature = true\n')
    gitleaksMocks.scanStagedWithGitleaks.mockResolvedValue({ status: 'unavailable' })

    const result = await prepareTaskChange({
      config: { ...baseConfig, secretScanner: 'gitleaks' },
      commitOnly: true,
      baseCommit: base,
      taskId: 'secret-missing',
      title: 'Fehlendes Binary',
      worktree: dir
    })

    expect(result).toEqual(expect.objectContaining({ status: 'blocked', result: 'blocked' }))
    expect(result.message).toMatch(/gitleaks ist konfiguriert, aber nicht installiert/)
    // No silent pass-through: nothing was committed.
    expect(await git(dir, 'rev-parse', 'HEAD')).toBe(base)
    expect(gitleaksMocks.scanStagedWithGitleaks).toHaveBeenCalledWith(dir)
  }, 20_000)

  it("commits with 'gitleaks' as the only secret scanner when the scan is clean", async () => {
    const { dir, base } = await repo()
    // The builtin regex scan would block this line; 'gitleaks' mode skips it.
    await writeFile(join(dir, 'deploy.ts'), `export const deployKey = '${fakeAwsKey}'\n`)

    const result = await prepareTaskChange({
      config: { ...baseConfig, secretScanner: 'gitleaks' },
      commitOnly: true,
      baseCommit: base,
      taskId: 'secret-gitleaks-only',
      title: 'Nur gitleaks',
      worktree: dir
    })

    expect(result.result).toBe('committed')
    expect(result.change?.files).toContain('deploy.ts')
    expect(await git(dir, 'rev-parse', 'HEAD^')).toBe(base)
    // Both staged-diff gate sites (before and after the quality gates) scan.
    expect(gitleaksMocks.scanStagedWithGitleaks).toHaveBeenCalledTimes(2)
    expect(gitleaksMocks.scanStagedWithGitleaks).toHaveBeenCalledWith(dir)
  }, 20_000)

  it("never invokes gitleaks for the default 'builtin' scanner", async () => {
    const scanStaged = vi.fn()
    const cleanDiff = ['+++ b/src/a.ts', '+export const a = 1'].join('\n')
    await expect(
      assertSecretScanGates('/worktree', cleanDiff, { securityGateExcludes: [] }, { scanStaged })
    ).resolves.toBeDefined()

    const secretDiff = ['+++ b/src/a.ts', `+const key = '${fakeAwsKey}'`].join('\n')
    await expect(
      assertSecretScanGates('/worktree', secretDiff, { securityGateExcludes: [] }, { scanStaged })
    ).rejects.toThrow(/Moegliches Secret/)

    expect(scanStaged).not.toHaveBeenCalled()
  })
})
