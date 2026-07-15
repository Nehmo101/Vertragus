import { afterEach, describe, expect, it } from 'vitest'
import { lstat, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureWorktreeDependencies } from './dependencyBootstrap'

const roots: string[] = []

afterEach(async () => {
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
