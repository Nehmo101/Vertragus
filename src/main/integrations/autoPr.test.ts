import { describe, expect, it, vi } from 'vitest'
import { autoPrInternals, type RemoteCiCommandResult } from './autoPr'

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
    expect(runGates).toHaveBeenCalledWith(integrationPath, ['corepack pnpm lint'])
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
