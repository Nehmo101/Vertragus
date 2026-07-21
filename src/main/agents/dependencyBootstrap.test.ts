import { afterEach, describe, expect, it, vi } from 'vitest'
import { lstat, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const resolveLaunchMock = vi.hoisted(() =>
  vi.fn(async (_command: string, args: string[]) => {
    // The warm-up (pnpm fetch) only primes the shared store — it must not
    // materialize a node_modules tree the way a per-worktree install does.
    if (args.includes('fetch')) {
      return { file: process.execPath, args: ['-e', 'void 0'] }
    }
    // A real node call simulates the install: it creates node_modules in the
    // current cwd without needing a package manager.
    return {
      file: process.execPath,
      args: ['-e', 'require("node:fs").mkdirSync("node_modules", { recursive: true })']
    }
  })
)
vi.mock('@main/agents/resolveCommand', () => ({ resolveLaunch: resolveLaunchMock }))

import {
  ensureWorktreeDependencies,
  __resetDependencyBootstrapCaches
} from './dependencyBootstrap'

const roots: string[] = []

const fetchCalls = (): unknown[] =>
  resolveLaunchMock.mock.calls.filter(([, args]) => (args as string[]).includes('fetch'))
const installCalls = (): unknown[] =>
  resolveLaunchMock.mock.calls.filter(([, args]) => (args as string[]).includes('install'))

afterEach(async () => {
  vi.clearAllMocks()
  __resetDependencyBootstrapCaches()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function pnpmRepo(): Promise<string> {
  const fixture = await mkdtemp(join(tmpdir(), 'orca-deps-'))
  roots.push(fixture)
  const root = join(fixture, 'repo')
  await mkdir(root, { recursive: true })
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'fixture', packageManager: 'pnpm@11.6.0' }))
  await writeFile(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n')
  return root
}

async function worktree(root: string, name: string): Promise<string> {
  const dir = join(root, '.orca-worktrees', name)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'fixture' }))
  await writeFile(join(dir, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n')
  return dir
}

describe('worktree dependency bootstrap', () => {
  it('skips repositories without a Node package', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-deps-none-'))
    roots.push(root)

    await expect(ensureWorktreeDependencies(root, root)).resolves.toEqual(
      expect.objectContaining({ status: 'not-applicable' })
    )
  })

  it('reuses an existing dependency tree without reinstalling', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-deps-present-'))
    roots.push(root)
    await writeFile(join(root, 'package.json'), JSON.stringify({
      name: 'fixture',
      packageManager: 'pnpm@11.6.0'
    }))
    await mkdir(join(root, 'node_modules'))

    await expect(ensureWorktreeDependencies(root, root)).resolves.toEqual(
      expect.objectContaining({
        status: 'present',
        toolchain: 'pnpm@11.6.0'
      })
    )
    expect(resolveLaunchMock).not.toHaveBeenCalled()
  })

  it('warms the store once, then materializes the worktree offline with lifecycle scripts enabled', async () => {
    const root = await pnpmRepo()
    const work = await worktree(root, 'task-1')

    await expect(ensureWorktreeDependencies(root, work)).resolves.toEqual(
      expect.objectContaining({ status: 'installed' })
    )
    // One coordinated online warm-up, then an offline per-worktree materialization.
    expect(resolveLaunchMock).toHaveBeenCalledWith('corepack', ['pnpm', 'fetch'])
    expect(resolveLaunchMock).toHaveBeenCalledWith('corepack', [
      'pnpm', 'install', '--frozen-lockfile', '--prefer-offline'
    ])
    // No --ignore-scripts: lifecycle scripts (e.g. prisma generate) must run.
    expect(installCalls()).toHaveLength(1)
    // A real install in the worktree instead of a symlink to the main checkout.
    expect((await lstat(join(work, 'node_modules'))).isSymbolicLink()).toBe(false)
  })

  it('coordinates a single online warm-up across five concurrent worktrees', async () => {
    const root = await pnpmRepo()
    const worktrees = await Promise.all(
      ['a', 'b', 'c', 'd', 'e'].map((name) => worktree(root, name))
    )

    const results = await Promise.all(
      worktrees.map((dir) => ensureWorktreeDependencies(root, dir))
    )

    expect(results.every((r) => r.status === 'installed')).toBe(true)
    // The expensive online fetch/warm-up ran exactly once for all five, not 5×.
    expect(fetchCalls()).toHaveLength(1)
    // Each worktree still gets its own local materialization (own node_modules/.bin).
    expect(installCalls()).toHaveLength(5)
    for (const dir of worktrees) {
      expect((await lstat(join(dir, 'node_modules'))).isSymbolicLink()).toBe(false)
    }
  })

  it('re-runs the warm-up when the lockfile content changes', async () => {
    const root = await pnpmRepo()
    const first = await worktree(root, 'v1')
    await ensureWorktreeDependencies(root, first)
    expect(fetchCalls()).toHaveLength(1)

    // A dependency change rewrites the lockfile: a new fingerprint → new warm-up.
    await writeFile(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n# changed\n')
    const second = await worktree(root, 'v2')
    await ensureWorktreeDependencies(root, second)

    expect(fetchCalls()).toHaveLength(2)
  })

  it('falls back to a normal install when the warm-up fails, without poisoning the cache', async () => {
    const root = await pnpmRepo()

    // First warm-up attempt fails; the install must still complete online.
    resolveLaunchMock.mockImplementationOnce(async () => ({
      file: process.execPath,
      args: ['-e', 'process.exit(3)']
    }))
    const first = await worktree(root, 'fallback-1')
    await expect(ensureWorktreeDependencies(root, first)).resolves.toEqual(
      expect.objectContaining({ status: 'installed' })
    )
    // Fell back to the online (non-prefer-offline) install.
    expect(resolveLaunchMock).toHaveBeenCalledWith('corepack', ['pnpm', 'install', '--frozen-lockfile'])

    // A failed warm-up is evicted, so the next fan-out retries it (not poisoned).
    const second = await worktree(root, 'fallback-2')
    await ensureWorktreeDependencies(root, second)
    expect(fetchCalls().length).toBeGreaterThanOrEqual(2)
  })

  it('propagates an install failure to concurrent callers and evicts it for retry', async () => {
    const root = await pnpmRepo()
    const work = await worktree(root, 'shared')

    // Warm-up succeeds; the shared install for this worktree fails once.
    resolveLaunchMock.mockImplementation(async (_command: string, args: string[]) => {
      if (args.includes('fetch')) return { file: process.execPath, args: ['-e', 'void 0'] }
      return { file: process.execPath, args: ['-e', 'process.exit(7)'] }
    })

    const [a, b] = await Promise.allSettled([
      ensureWorktreeDependencies(root, work),
      ensureWorktreeDependencies(root, work)
    ])
    expect(a.status).toBe('rejected')
    expect(b.status).toBe('rejected')

    // The failure was evicted: a later attempt with a working install succeeds.
    resolveLaunchMock.mockImplementation(async (_command: string, args: string[]) => {
      if (args.includes('fetch')) return { file: process.execPath, args: ['-e', 'void 0'] }
      return {
        file: process.execPath,
        args: ['-e', 'require("node:fs").mkdirSync("node_modules", { recursive: true })']
      }
    })
    await expect(ensureWorktreeDependencies(root, work)).resolves.toEqual(
      expect.objectContaining({ status: 'installed' })
    )
  })

  it('falls back to the shared cache symlink when no lockfile toolchain is known', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'orca-deps-link-'))
    roots.push(fixture)
    const root = join(fixture, 'repo')
    const work = join(root, '.orca-worktrees', 'task-2')
    await mkdir(work, { recursive: true })
    await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'fixture' }))
    await mkdir(join(root, 'node_modules'))

    await expect(ensureWorktreeDependencies(root, work)).resolves.toEqual(
      expect.objectContaining({ status: 'linked' })
    )
    expect(resolveLaunchMock).not.toHaveBeenCalled()
    expect((await lstat(join(work, 'node_modules'))).isSymbolicLink()).toBe(true)
  })

  it('maps a missing package-manager binary to a clear PATH hint', async () => {
    const root = await pnpmRepo()
    const work = await worktree(root, 'task-3')
    // Retro Lauf 1: corepack fehlte im PATH des App-Prozesses (spawn ENOENT).
    // Both the warm-up and the install resolve to the missing binary.
    resolveLaunchMock.mockResolvedValue({ file: join(root, 'missing', 'corepack'), args: [] })

    await expect(ensureWorktreeDependencies(root, work)).rejects.toThrow(/fnm\/nvm/)
  })

  it('rejects an invalid path-traversal target outside the repository before linking', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'orca-deps-boundary-'))
    roots.push(fixture)
    const root = join(fixture, 'repository')
    const outsideTarget = join(root, '..', 'evil')
    await mkdir(root)
    await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'fixture' }))
    await mkdir(join(root, 'node_modules'))

    await expect(ensureWorktreeDependencies(root, outsideTarget)).rejects.toThrow(
      /außerhalb des Repository-Roots/
    )
    await expect(lstat(join(outsideTarget, 'node_modules'))).rejects.toMatchObject({
      code: 'ENOENT'
    })
  })
})
