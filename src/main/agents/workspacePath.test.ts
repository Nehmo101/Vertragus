import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  canonicalWorkspacePath,
  sameWorkspacePath,
  workspaceContains,
  workspacePathKey
} from './workspacePath'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('workspace path canonicalization', () => {
  it('collapses symlink/junction aliases to one workspace identity', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-path-'))
    roots.push(root)
    const real = join(root, 'real')
    const alias = join(root, 'alias')
    await mkdir(real)
    await symlink(real, alias, process.platform === 'win32' ? 'junction' : 'dir')

    expect(await sameWorkspacePath(real, alias)).toBe(true)
    expect(workspacePathKey(await canonicalWorkspacePath(alias))).toBe(
      workspacePathKey(await canonicalWorkspacePath(real))
    )
  })

  it('recognizes children but rejects sibling paths', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-root-'))
    roots.push(root)
    const workspace = join(root, 'workspace')
    const child = join(workspace, 'src')
    const sibling = join(root, 'sibling')
    await mkdir(child, { recursive: true })
    await mkdir(sibling)

    expect(await workspaceContains(workspace, child)).toBe(true)
    expect(await workspaceContains(workspace, sibling)).toBe(false)
  })
})
