import { beforeEach, describe, expect, it, vi } from 'vitest'

const { execFileMock, accessMock, realpathMock } = vi.hoisted(() => ({
  execFileMock: vi.fn(),
  accessMock: vi.fn(),
  realpathMock: vi.fn()
}))
vi.mock('node:child_process', () => ({
  execFile: (...args: unknown[]) => execFileMock(...args)
}))
vi.mock('node:fs/promises', () => ({
  access: accessMock,
  realpath: realpathMock
}))
vi.mock('@main/providers/processPath', () => ({
  refreshProcessPathFromSystem: vi.fn(async () => undefined)
}))

import { resolveLaunch } from './resolveCommand'

type ExecCallback = (error: Error | null, value?: { stdout: string; stderr: string }) => void

const normalize = (value: string): string => value.replace(/\\/g, '/')

describe('node toolchain fallback (Retro Lauf 1: spawn corepack ENOENT)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('resolves corepack next to the real node binary when PATH misses it', async () => {
    // fnm/nvm-Szenario: nur `node` ist im PATH auffindbar, corepack fehlt.
    execFileMock.mockImplementation((_file: string, args: string[], _opts: unknown, cb: ExecCallback) => {
      const target = Array.isArray(args) ? args[args.length - 1] : ''
      if (target === 'node') cb(null, { stdout: '/fake/shim/node\n', stderr: '' })
      else cb(new Error('not found'))
    })
    realpathMock.mockResolvedValue('/fake/install/bin/node')
    accessMock.mockImplementation(async (candidate: string) => {
      if (!normalize(candidate).startsWith('/fake/install/bin/corepack')) {
        throw new Error('ENOENT')
      }
    })

    const launch = await resolveLaunch('corepack', ['pnpm', 'install', '--frozen-lockfile'])

    expect(normalize(launch.file)).toMatch(/^\/fake\/install\/bin\/corepack(\.exe|\.com|\.cmd|\.bat)?$/)
    expect(launch.args.slice(-3)).toEqual(['pnpm', 'install', '--frozen-lockfile'])
  })

  it('leaves non-toolchain commands unresolved so the spawn surfaces the real error', async () => {
    execFileMock.mockImplementation((_file: string, _args: string[], _opts: unknown, cb: ExecCallback) => {
      cb(new Error('not found'))
    })

    const launch = await resolveLaunch('definitely-missing-cli', ['--version'])

    expect(launch).toEqual({ file: 'definitely-missing-cli', args: ['--version'] })
    expect(accessMock).not.toHaveBeenCalled()
  })
})
