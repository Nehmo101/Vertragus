import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { workspaceProfileSchema } from '@shared/profile'

const mocks = vi.hoisted(() => ({ execFile: vi.fn() }))

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, execFile: mocks.execFile }
})

import {
  applySandbox,
  BWRAP_MISSING_MESSAGE,
  bwrapAvailable,
  resetBwrapAvailabilityForTests,
  SANDBOX_RW_HOME_PATHS,
  wrapWithBwrap
} from './sandboxLaunch'

const launch = { file: '/usr/bin/claude', args: ['-p', 'multiline\nprompt', '--verbose'] }
const wrapOpts = { workingDir: '/repos/wt-1', homeDir: '/home/dev' }

type ExecFileCallback = (error: Error | null, stdout?: string, stderr?: string) => void
function probeAnswers(error: Error | null): void {
  mocks.execFile.mockImplementation((...args: unknown[]) => {
    const callback = args.at(-1) as ExecFileCallback
    callback(error, error ? '' : 'bubblewrap 0.8.0', '')
  })
}

beforeEach(() => resetBwrapAvailabilityForTests())
afterEach(() => vi.clearAllMocks())

describe('wrapWithBwrap', () => {
  it('builds the deterministic bwrap argv: RO root, RW worktree, fresh dev/proc/tmp, die-with-parent', () => {
    const wrapped = wrapWithBwrap(launch, wrapOpts)

    expect(wrapped.file).toBe('bwrap')
    // Read-only root comes first so every later RW bind can override it.
    expect(wrapped.args.slice(0, 3)).toEqual(['--ro-bind', '/', '/'])
    expect(wrapped.args).toEqual(
      expect.arrayContaining(['--dev', '/dev', '--proc', '/proc', '--tmpfs', '/tmp'])
    )
    // The worktree is the only writable repository path.
    const worktreeBind = wrapped.args.indexOf('--bind')
    expect(wrapped.args.slice(worktreeBind, worktreeBind + 3)).toEqual([
      '--bind', '/repos/wt-1', '/repos/wt-1'
    ])
    expect(wrapped.args).toEqual(expect.arrayContaining(['--chdir', '/repos/wt-1']))
    expect(wrapped.args).toContain('--unshare-pid')
    expect(wrapped.args).toContain('--die-with-parent')
    // The wrapped CLI launch follows the `--` separator untouched.
    expect(wrapped.args.slice(-5)).toEqual(['--', '/usr/bin/claude', '-p', 'multiline\nprompt', '--verbose'])
  })

  it('keeps the network namespace shared — provider APIs must stay reachable', () => {
    const wrapped = wrapWithBwrap(launch, wrapOpts)

    expect(wrapped.args).not.toContain('--unshare-net')
    expect(wrapped.args).not.toContain('--unshare-all')
    // Deliberately no user namespace either (setuid bwrap compatibility).
    expect(wrapped.args).not.toContain('--unshare-user')
  })

  it('binds every documented provider home path RW via --bind-try', () => {
    const wrapped = wrapWithBwrap(launch, wrapOpts)

    expect(SANDBOX_RW_HOME_PATHS).toEqual(expect.arrayContaining(['.claude', '.codex', '.config', '.cache']))
    for (const relative of SANDBOX_RW_HOME_PATHS) {
      const absolute = join('/home/dev', relative)
      const at = wrapped.args.indexOf(absolute)
      expect(at).toBeGreaterThan(0)
      expect(wrapped.args.slice(at - 1, at + 2)).toEqual(['--bind-try', absolute, absolute])
    }
  })

  it('binds the run temp dir RW after the /tmp tmpfs so the parent can read result files', () => {
    const tempDir = '/tmp/vertragus-codex-abc123'
    const wrapped = wrapWithBwrap(launch, { ...wrapOpts, tempDir })

    const tmpfsAt = wrapped.args.indexOf('--tmpfs')
    const tempBindAt = wrapped.args.indexOf(tempDir)
    expect(tmpfsAt).toBeGreaterThan(0)
    expect(tempBindAt).toBeGreaterThan(tmpfsAt)
    expect(wrapped.args.slice(tempBindAt - 1, tempBindAt + 2)).toEqual(['--bind', tempDir, tempDir])
  })

  it('is pure: the input launch stays untouched', () => {
    const original = { file: launch.file, args: [...launch.args] }
    wrapWithBwrap(launch, wrapOpts)
    expect(launch).toEqual(original)
  })
})

describe('applySandbox', () => {
  it("is a strict no-op for 'none' and for legacy profiles without the field", () => {
    expect(applySandbox(launch, 'none', wrapOpts)).toBe(launch)
    expect(applySandbox(launch, undefined, wrapOpts)).toBe(launch)
  })

  it("wraps with bwrap for 'bwrap'", () => {
    const wrapped = applySandbox(launch, 'bwrap', wrapOpts)
    expect(wrapped.file).toBe('bwrap')
    expect(wrapped.args).toEqual(wrapWithBwrap(launch, wrapOpts).args)
  })
})

describe('bwrapAvailable', () => {
  it('probes `bwrap --version` once and caches a positive result', async () => {
    probeAnswers(null)

    await expect(bwrapAvailable()).resolves.toBe(true)
    await expect(bwrapAvailable()).resolves.toBe(true)

    expect(mocks.execFile).toHaveBeenCalledTimes(1)
    expect(mocks.execFile.mock.calls[0]?.[0]).toBe('bwrap')
    expect(mocks.execFile.mock.calls[0]?.[1]).toEqual(['--version'])
  })

  it('does not cache a missing bwrap — installing it works without an app restart', async () => {
    probeAnswers(new Error('ENOENT: bwrap not found'))
    await expect(bwrapAvailable()).resolves.toBe(false)

    probeAnswers(null)
    await expect(bwrapAvailable()).resolves.toBe(true)
    expect(mocks.execFile).toHaveBeenCalledTimes(2)
  })

  it('tells the user to install bubblewrap or disable the sandbox', () => {
    expect(BWRAP_MISSING_MESSAGE).toContain('bubblewrap installieren')
    expect(BWRAP_MISSING_MESSAGE).toContain("'none'")
  })
})

describe('profile schema backward compatibility', () => {
  it("defaults older profiles without the field to sandbox 'none' and accepts 'bwrap'", () => {
    const legacy = workspaceProfileSchema.parse({ id: 'p1', name: 'Legacy' })
    expect(legacy.sandbox).toBe('none')

    const optedIn = workspaceProfileSchema.parse({ id: 'p2', name: 'Yolo', sandbox: 'bwrap' })
    expect(optedIn.sandbox).toBe('bwrap')
  })
})
