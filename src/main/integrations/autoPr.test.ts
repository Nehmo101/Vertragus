import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ exec: vi.fn() }))

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, exec: mocks.exec }
})

import { autoPrInternals, scratchFiles, type RemoteCiCommandResult } from './autoPr'

beforeEach(() => {
  mocks.exec.mockReset()
  mocks.exec.mockImplementation((...args: unknown[]) => {
    const callback = args[args.length - 1]
    if (typeof callback === 'function') callback(null, '', '')
  })
})

function normalizedPath(value: string | undefined): string | undefined {
  return value?.replaceAll('\\', '/')
}

function lastGateInvocation(): { command: string; env: NodeJS.ProcessEnv } {
  const [command, options] = mocks.exec.mock.calls[mocks.exec.mock.calls.length - 1] ?? []
  return {
    command: String(command),
    env: (options as { env: NodeJS.ProcessEnv }).env
  }
}

function commandResult(overrides: Partial<RemoteCiCommandResult> = {}): RemoteCiCommandResult {
  return {
    stdout: '',
    stderr: '',
    exitCode: 0,
    timedOut: false,
    ...overrides
  }
}

describe('autoPr safety helpers', () => {
  it('creates stable safe slugs', () => {
    expect(autoPrInternals.safeSlug('Checkout Flow / API #42')).toBe('checkout-flow-api-42')
    expect(autoPrInternals.safeSlug('***')).toBe('orca-task')
  })

  it('blocks common secret shapes', () => {
    expect(() =>
      autoPrInternals.assertDiffLooksSafe('+ -----BEGIN PRIVATE KEY-----\n+ sensitive')
    ).toThrow(/Secret/)
    expect(() => autoPrInternals.assertDiffLooksSafe('+ const value = "safe"')).not.toThrow()
  })

  it('prefers explicit base branch over profile default', () => {
    expect(autoPrInternals.pickBaseBranch('main', 'develop', 'master')).toBe('main')
    expect(autoPrInternals.pickBaseBranch('', 'develop', 'master')).toBe('develop')
    expect(autoPrInternals.pickBaseBranch('', '', 'master')).toBe('master')
    expect(autoPrInternals.pickBaseBranch('', '', '')).toBe('main')
  })

  it('classifies failed and cancelled GitHub checks', () => {
    expect(autoPrInternals.remoteCiFromChecks([
      { bucket: 'fail', name: 'quality', workflow: 'CI', link: 'https://checks/fail' }
    ], 'https://pr')).toEqual(expect.objectContaining({
      status: 'failed',
      url: 'https://checks/fail'
    }))
    expect(autoPrInternals.remoteCiFromChecks([
      { bucket: 'cancel', name: 'windows-build' }
    ], 'https://pr')).toEqual(expect.objectContaining({ status: 'cancelled' }))
  })

  it('waits for delayed check registration and returns the final result', async () => {
    let now = 0
    const responses = [
      commandResult({ exitCode: 1, stderr: 'no checks reported on the branch' }),
      commandResult({
        exitCode: 8,
        stdout: JSON.stringify([{ bucket: 'pending', name: 'quality', link: 'https://checks/pending' }])
      }),
      commandResult(),
      commandResult({
        stdout: JSON.stringify([{ bucket: 'pass', name: 'quality', link: 'https://checks/pass' }])
      })
    ]
    const runChecks = vi.fn(async (_command: unknown) => responses.shift() ?? commandResult())
    const updates: string[] = []

    const outcome = await autoPrInternals.monitorRemoteCi({
      cwd: 'C:/repo',
      prUrl: 'https://pr',
      onUpdate: (update) => updates.push(update.status)
    }, {
      now: () => now,
      delay: async (ms) => { now += ms },
      runChecks
    })

    expect(outcome).toEqual(expect.objectContaining({ status: 'passed', url: 'https://checks/pass' }))
    expect(updates).toEqual(['waiting', 'pending', 'passed'])
    expect(runChecks.mock.calls[2]?.[0]).toEqual(expect.objectContaining({ watch: true }))
  })

  it('trusts the watch exit code when the follow-up read stays pending', async () => {
    let now = 0
    // Registration read -> pending; --watch exits 0 (all green); every follow-up
    // read still races as pending. The old code returned timed-out here; now the
    // green watch exit code decides.
    const responses: RemoteCiCommandResult[] = [
      commandResult({ stdout: JSON.stringify([{ bucket: 'pending', name: 'quality', link: 'https://checks' }]) }),
      commandResult({ exitCode: 0 })
    ]
    const runChecks = vi.fn(async (_command: { watch?: boolean }) => {
      if (responses.length > 0) return responses.shift()!
      // All later follow-up reads keep reporting pending.
      return commandResult({ stdout: JSON.stringify([{ bucket: 'pending', name: 'quality', link: 'https://checks' }]) })
    })

    const outcome = await autoPrInternals.monitorRemoteCi({
      cwd: 'C:/repo',
      prUrl: 'https://pr'
    }, {
      now: () => now,
      delay: async (ms) => { now += ms },
      runChecks
    })

    expect(outcome.status).toBe('passed')
    expect(runChecks.mock.calls.some(([command]) => (command as { watch?: boolean }).watch === true)).toBe(true)
  })

  it('still reports a genuine failure surfaced by the follow-up read', async () => {
    let now = 0
    const responses: RemoteCiCommandResult[] = [
      commandResult({ stdout: JSON.stringify([{ bucket: 'pending', name: 'quality', link: 'https://checks' }]) }),
      commandResult({ exitCode: 8 }),
      commandResult({ stdout: JSON.stringify([{ bucket: 'fail', name: 'quality', link: 'https://checks/fail' }]) })
    ]
    const runChecks = vi.fn(async () => responses.shift() ?? commandResult())
    const outcome = await autoPrInternals.monitorRemoteCi({
      cwd: 'C:/repo',
      prUrl: 'https://pr'
    }, { now: () => now, delay: async (ms) => { now += ms }, runChecks })
    expect(outcome.status).toBe('failed')
  })

  it('reports a bounded timeout when GitHub never registers checks', async () => {
    let now = 0
    const outcome = await autoPrInternals.monitorRemoteCi({
      cwd: 'C:/repo',
      prUrl: 'https://pr'
    }, {
      now: () => now,
      delay: async (ms) => { now += ms },
      runChecks: async () => commandResult({
        exitCode: 1,
        stderr: 'no checks reported on the branch'
      })
    })

    expect(outcome.status).toBe('timed-out')
    expect(now).toBeGreaterThan(90_000)
  })

  it('reports authentication failures separately from check failures', async () => {
    const outcome = await autoPrInternals.monitorRemoteCi({
      cwd: 'C:/repo',
      prUrl: 'https://pr'
    }, {
      now: () => 0,
      delay: async () => undefined,
      runChecks: async () => commandResult({
        exitCode: 1,
        stderr: 'authentication token is invalid'
      })
    })

    expect(outcome.status).toBe('unavailable')
    expect(outcome.message).toMatch(/Authentifizierung/)
  })

  it('bootstraps a fresh integration worktree before running its quality gates', async () => {
    const calls: string[] = []
    const bootstrap = vi.fn(async () => {
      calls.push('bootstrap')
      return { status: 'linked' as const, detail: 'shared dependencies linked' }
    })
    const runGates = vi.fn(async () => {
      calls.push('gates')
    })
    const repositoryRoot = 'C:\\repo'
    const integrationPath = 'C:\\repo\\.orca-worktrees\\integration\\orca-goal'

    await autoPrInternals.runIntegrationQualityGates(
      repositoryRoot,
      integrationPath,
      ['corepack pnpm lint'],
      { bootstrap, runGates }
    )

    expect(calls).toEqual(['bootstrap', 'gates'])
    expect(bootstrap).toHaveBeenCalledWith(repositoryRoot, integrationPath)
    expect(runGates).toHaveBeenCalledWith(
      integrationPath,
      ['corepack pnpm lint'],
      repositoryRoot
    )
  })

  it('reports dependency bootstrap failures clearly and skips integration gates', async () => {
    const runGates = vi.fn(async () => undefined)

    await expect(autoPrInternals.runIntegrationQualityGates(
      'C:\\repo',
      'C:\\repo\\.orca-worktrees\\integration\\orca-goal',
      ['corepack pnpm lint'],
      {
        bootstrap: vi.fn(async () => {
          throw new Error('Junction konnte nicht erstellt werden')
        }),
        runGates
      }
    )).rejects.toThrow(
      /Quality Gate fehlgeschlagen: Dependency-Bootstrap[\s\S]*Integration-Worktree[\s\S]*Junction konnte nicht erstellt werden/
    )
    expect(runGates).not.toHaveBeenCalled()
  })

  it('rejects path traversal outside the managed integration root before bootstrapping', async () => {
    const bootstrap = vi.fn(async () => undefined)
    const runGates = vi.fn(async () => undefined)

    await expect(autoPrInternals.runIntegrationQualityGates(
      '/repo',
      '/repo/.orca-worktrees/integration/../../outside',
      ['corepack pnpm lint'],
      { bootstrap, runGates }
    )).rejects.toThrow(/nicht innerhalb des verwalteten Integration-Verzeichnisses/)

    expect(bootstrap).not.toHaveBeenCalled()
    expect(runGates).not.toHaveBeenCalled()
  })

  it('adds the target worktree local binaries to the gate shell PATH', () => {
    expect(autoPrInternals.qualityGateShellCommand(
      "C:\\repo's copy",
      'eslint .',
      'win32'
    )).toBe("& { $env:PATH = 'C:\\repo''s copy\\node_modules\\.bin;' + $env:PATH; eslint . }")
    expect(autoPrInternals.qualityGateShellCommand(
      "/repo's copy",
      'eslint .',
      'linux'
    )).toBe("export PATH='/repo'\"'\"'s copy/node_modules/.bin':\"$PATH\"; eslint .")
  })
})

describe('autoPr commit hygiene helpers', () => {
  it('detects the scratch-file patterns seen in retros and spares real files', () => {
    expect(scratchFiles([
      'docs/00-inventory.md.check',
      'docs/00-inventory.md.c9check',
      'ARCHITECTURE.md.origcheck',
      '.verify-new-body-tmp.md',
      'notes/.verify-orig-tmp.md',
      'src/feature.ts.orig',
      'src/feature.ts.rej',
      'backup.bak',
      'draft.tmp',
      'editor-swap.ts~'
    ])).toHaveLength(10)
    expect(scratchFiles([
      'src/healthcheck.ts',
      'src/check.spec.ts',
      'docs/checklist.md',
      'src/verify-command.ts',
      'templates/report.md'
    ])).toEqual([])
  })

  it('classifies missing gate tooling as infrastructure failure', async () => {
    mocks.exec.mockImplementation((...args: unknown[]) => {
      const callback = args[args.length - 1]
      if (typeof callback === 'function') {
        callback(new Error('/bin/sh: 1: eslint: command not found'), '', '')
      }
    })
    await expect(
      autoPrInternals.runQualityGates('/repo/worktree', ['eslint .'])
    ).rejects.toMatchObject({ code: 'quality-gate-failed', infrastructure: true })

    mocks.exec.mockImplementation((...args: unknown[]) => {
      const callback = args[args.length - 1]
      if (typeof callback === 'function') {
        callback(new Error('3 tests failed'), '', '')
      }
    })
    await expect(
      autoPrInternals.runQualityGates('/repo/worktree', ['pnpm test'])
    ).rejects.toMatchObject({ code: 'quality-gate-failed', infrastructure: false })
  })

  it('classifies an esbuild spawn EPERM gate failure as infrastructure', async () => {
    mocks.exec.mockImplementation((...args: unknown[]) => {
      const callback = args[args.length - 1]
      if (typeof callback === 'function') {
        callback(new Error('Error: spawn /repo/node_modules/@esbuild/linux-x64/bin/esbuild EPERM'), '', '')
      }
    })
    await expect(
      autoPrInternals.runQualityGates('/repo/worktree', ['pnpm test'])
    ).rejects.toMatchObject({ code: 'quality-gate-failed', infrastructure: true })
  })
})

describe('autoPr quality gate environment', () => {
  it('prefixes the cwd binary directory and preserves the existing PATH', async () => {
    await autoPrInternals.runQualityGates(
      '/repo/worktree',
      ['pnpm lint'],
      '/repo/worktree',
      { inheritedEnv: { PATH: '/system/bin' }, platform: 'linux' }
    )

    expect(normalizedPath(lastGateInvocation().env.PATH)).toBe(
      '/repo/worktree/node_modules/.bin:/system/bin'
    )
  })

  it('preserves the Windows Path key and uses semicolon separators', async () => {
    await autoPrInternals.runQualityGates(
      'C:/repo/worktree',
      ['pnpm lint'],
      'C:/repo/worktree',
      { inheritedEnv: { Path: 'C:/system/bin' }, platform: 'win32' }
    )

    const gateEnv = lastGateInvocation().env
    expect(normalizedPath(gateEnv.Path)).toBe(
      'C:/repo/worktree/node_modules/.bin;C:/system/bin'
    )
    expect(gateEnv.PATH).toBeUndefined()
  })

  it('adds the main workspace binaries for a worktree without node_modules', async () => {
    await autoPrInternals.runQualityGates(
      '/repo/.orca-worktrees/integration/branch',
      ['pnpm lint'],
      '/repo',
      { inheritedEnv: { PATH: '/system/bin' }, platform: 'linux' }
    )

    expect(normalizedPath(lastGateInvocation().env.PATH)).toBe(
      '/repo/.orca-worktrees/integration/branch/node_modules/.bin:' +
      '/repo/node_modules/.bin:/system/bin'
    )
  })

  it('does not leak a secret through the command or logs and leaves other env values unchanged', async () => {
    const privateMarker = 'private-marker-value'
    const inheritedEnv = { PATH: '/system/bin', ORCA_PRIVATE_MARKER: privateMarker }
    const originalEnv = { ...inheritedEnv }
    const logs = [
      vi.spyOn(console, 'log').mockImplementation(() => undefined),
      vi.spyOn(console, 'info').mockImplementation(() => undefined),
      vi.spyOn(console, 'warn').mockImplementation(() => undefined),
      vi.spyOn(console, 'error').mockImplementation(() => undefined)
    ]

    await autoPrInternals.runQualityGates(
      '/repo/worktree',
      ['pnpm lint'],
      '/repo/worktree',
      { inheritedEnv, platform: 'linux' }
    )

    const invocation = lastGateInvocation()
    expect(inheritedEnv).toEqual(originalEnv)
    expect(invocation.env).not.toBe(inheritedEnv)
    expect(invocation.env.ORCA_PRIVATE_MARKER).toBe(privateMarker)
    expect(invocation.command).toBe('pnpm lint')
    expect(invocation.command).not.toContain(privateMarker)
    for (const log of logs) expect(log).not.toHaveBeenCalled()
  })
})

describe('autoPr quality gate environment', () => {
  it('prefixes the cwd binary directory and preserves the existing PATH', async () => {
    await autoPrInternals.runQualityGates(
      '/repo/worktree',
      ['pnpm lint'],
      '/repo/worktree',
      { inheritedEnv: { PATH: '/system/bin' }, platform: 'linux' }
    )

    expect(normalizedPath(lastGateInvocation().env.PATH)).toBe(
      '/repo/worktree/node_modules/.bin:/system/bin'
    )
  })

  it('preserves the Windows Path key and uses semicolon separators', async () => {
    await autoPrInternals.runQualityGates(
      'C:/repo/worktree',
      ['pnpm lint'],
      'C:/repo/worktree',
      { inheritedEnv: { Path: 'C:/system/bin' }, platform: 'win32' }
    )

    const gateEnv = lastGateInvocation().env
    expect(normalizedPath(gateEnv.Path)).toBe(
      'C:/repo/worktree/node_modules/.bin;C:/system/bin'
    )
    expect(gateEnv.PATH).toBeUndefined()
  })

  it('adds the main workspace binaries for a worktree without node_modules', async () => {
    await autoPrInternals.runQualityGates(
      '/repo/.orca-worktrees/integration/branch',
      ['pnpm lint'],
      '/repo',
      { inheritedEnv: { PATH: '/system/bin' }, platform: 'linux' }
    )

    expect(normalizedPath(lastGateInvocation().env.PATH)).toBe(
      '/repo/.orca-worktrees/integration/branch/node_modules/.bin:' +
      '/repo/node_modules/.bin:/system/bin'
    )
  })

  it('does not leak a secret through the command or logs and leaves other env values unchanged', async () => {
    const privateMarker = 'private-marker-value'
    const inheritedEnv = { PATH: '/system/bin', ORCA_PRIVATE_MARKER: privateMarker }
    const originalEnv = { ...inheritedEnv }
    const logs = [
      vi.spyOn(console, 'log').mockImplementation(() => undefined),
      vi.spyOn(console, 'info').mockImplementation(() => undefined),
      vi.spyOn(console, 'warn').mockImplementation(() => undefined),
      vi.spyOn(console, 'error').mockImplementation(() => undefined)
    ]

    await autoPrInternals.runQualityGates(
      '/repo/worktree',
      ['pnpm lint'],
      '/repo/worktree',
      { inheritedEnv, platform: 'linux' }
    )

    const invocation = lastGateInvocation()
    expect(inheritedEnv).toEqual(originalEnv)
    expect(invocation.env).not.toBe(inheritedEnv)
    expect(invocation.env.ORCA_PRIVATE_MARKER).toBe(privateMarker)
    expect(invocation.command).toBe('pnpm lint')
    expect(invocation.command).not.toContain(privateMarker)
    for (const log of logs) expect(log).not.toHaveBeenCalled()
  })
})
