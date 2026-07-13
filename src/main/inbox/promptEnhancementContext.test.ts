import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { workspaceProfileSchema, type WorkspaceProfile } from '@shared/profile'
import {
  inspectPromptWorkspaceContext,
  resolvePromptWorkspaceFile,
  validatePromptWorkspaceRoot
} from './promptEnhancementContext'

const cleanup: string[] = []
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

function profile(workingDir: string): WorkspaceProfile {
  return workspaceProfileSchema.parse({
    id: 'profile-one',
    name: 'Verified workspace',
    workingDir,
    agents: []
  })
}

describe('prompt workspace context inspection', () => {
  it('collects only bounded, confirmed repository metadata without exposing the root path', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-prompt-context-'))
    cleanup.push(root)
    await mkdir(join(root, '.github', 'workflows'), { recursive: true })
    await writeFile(
      join(root, 'package.json'),
      JSON.stringify({
        name: 'sample-app',
        packageManager: 'pnpm@11',
        scripts: { test: 'vitest', build: 'vite build' },
        dependencies: { electron: '1.0.0' }
      })
    )
    await writeFile(join(root, 'electron-builder.yml'), 'appId: example')
    await writeFile(join(root, '.github', 'workflows', 'ci.yml'), 'name: CI')

    const context = await inspectPromptWorkspaceContext(profile(root))
    const facts = context.repositoryFacts?.map((fact) => fact.text).join('\n') ?? ''
    expect(facts).toContain('sample-app')
    expect(facts).toContain('electron-builder.yml')
    expect(facts).toContain('ci.yml')
    expect(facts).not.toContain(root)
    expect(context.repositoryFacts?.every((fact) => fact.evidence === 'workspace-inspection')).toBe(true)
  })

  it('rejects workspace path traversal and absolute/relative file escape attempts', () => {
    expect(() => validatePromptWorkspaceRoot(`${tmpdir()}\\repo\\..\\secret`)).toThrow(/Traversal/)
    expect(() => resolvePromptWorkspaceFile(tmpdir(), '..\\secret.txt')).toThrow(/Traversal/)
    expect(() => resolvePromptWorkspaceFile(tmpdir(), join(tmpdir(), 'secret.txt'))).toThrow(/Traversal/)
  })

  it('ignores symlinks that escape the workspace root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-prompt-root-'))
    const outside = await mkdtemp(join(tmpdir(), 'orca-prompt-outside-'))
    cleanup.push(root, outside)
    await writeFile(join(outside, 'package.json'), JSON.stringify({ name: 'outside-secret-repo' }))
    try {
      await symlink(join(outside, 'package.json'), join(root, 'package.json'), 'file')
    } catch {
      return // Windows CI may not grant symlink creation; traversal checks remain covered above.
    }
    const context = await inspectPromptWorkspaceContext(profile(root))
    expect(JSON.stringify(context)).not.toContain('outside-secret-repo')
  })
})
