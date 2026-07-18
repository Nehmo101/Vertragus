import { afterEach, describe, expect, it, vi } from 'vitest'
import { lstat, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const resolveLaunchMock = vi.hoisted(() =>
  vi.fn(async (_command: string, _args: string[]) => ({
    // Ein echter node-Aufruf simuliert die Installation: er legt node_modules
    // im jeweiligen cwd an, ohne einen Paketmanager zu benötigen.
    file: process.execPath,
    args: ['-e', 'require("node:fs").mkdirSync("node_modules", { recursive: true })']
  }))
)
vi.mock('@main/agents/resolveCommand', () => ({ resolveLaunch: resolveLaunchMock }))

import { ensureWorktreeDependencies } from './dependencyBootstrap'

const roots: string[] = []

afterEach(async () => {
  vi.clearAllMocks()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

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
  })

  it('installs directly in the worktree with lifecycle scripts enabled', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'orca-deps-install-'))
    roots.push(fixture)
    const root = join(fixture, 'repo')
    const worktree = join(root, '.orca-worktrees', 'task-1')
    await mkdir(worktree, { recursive: true })
    await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'fixture' }))
    await writeFile(join(root, 'pnpm-lock.yaml'), '')
    await writeFile(join(worktree, 'package.json'), JSON.stringify({ name: 'fixture' }))
    await writeFile(join(worktree, 'pnpm-lock.yaml'), '')

    await expect(ensureWorktreeDependencies(root, worktree)).resolves.toEqual(
      expect.objectContaining({ status: 'installed' })
    )
    // Kein --ignore-scripts: Lifecycle-Skripte (z. B. prisma generate) müssen laufen.
    expect(resolveLaunchMock).toHaveBeenCalledWith('corepack', ['pnpm', 'install', '--frozen-lockfile'])
    // Echte Installation im Worktree statt Symlink auf den Haupt-Checkout.
    expect((await lstat(join(worktree, 'node_modules'))).isSymbolicLink()).toBe(false)
  })

  it('falls back to the shared cache symlink when no lockfile toolchain is known', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'orca-deps-link-'))
    roots.push(fixture)
    const root = join(fixture, 'repo')
    const worktree = join(root, '.orca-worktrees', 'task-2')
    await mkdir(worktree, { recursive: true })
    await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'fixture' }))
    await mkdir(join(root, 'node_modules'))

    await expect(ensureWorktreeDependencies(root, worktree)).resolves.toEqual(
      expect.objectContaining({ status: 'linked' })
    )
    expect(resolveLaunchMock).not.toHaveBeenCalled()
    expect((await lstat(join(worktree, 'node_modules'))).isSymbolicLink()).toBe(true)
  })

  it('maps a missing package-manager binary to a clear PATH hint', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'orca-deps-enoent-'))
    roots.push(fixture)
    const root = join(fixture, 'repo')
    const worktree = join(root, '.orca-worktrees', 'task-3')
    await mkdir(worktree, { recursive: true })
    await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'fixture' }))
    await writeFile(join(root, 'pnpm-lock.yaml'), '')
    await writeFile(join(worktree, 'package.json'), JSON.stringify({ name: 'fixture' }))
    await writeFile(join(worktree, 'pnpm-lock.yaml'), '')
    // Retro Lauf 1: corepack fehlte im PATH des App-Prozesses (spawn ENOENT).
    resolveLaunchMock.mockResolvedValueOnce({ file: join(fixture, 'missing', 'corepack'), args: [] })

    await expect(ensureWorktreeDependencies(root, worktree)).rejects.toThrow(/fnm\/nvm/)
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
