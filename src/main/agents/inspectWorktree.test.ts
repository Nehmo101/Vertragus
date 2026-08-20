import { execFile } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  INSPECT_DIFF_MAX_CHARS,
  inspectWorktree,
  parsePorcelainPaths,
  resolveInsideWorktree,
  snapshotWorktree
} from './inspectWorktree'
import { createWorktree } from './worktree'

const execFileAsync = promisify(execFile)

let repoPath: string

async function git(args: string[], cwd = repoPath): Promise<void> {
  await execFileAsync('git', args, { cwd, windowsHide: true })
}

beforeAll(async () => {
  repoPath = mkdtempSync(join(tmpdir(), 'vertragus-inspect-'))
  await git(['init', '-b', 'main'])
  await git(['config', 'user.email', 'test@vertragus.local'])
  await git(['config', 'user.name', 'Vertragus Test'])
  await git(['config', 'commit.gpgsign', 'false'])
  writeFileSync(join(repoPath, 'README.md'), '# fixture\n')
  await git(['add', '.'])
  await git(['commit', '-m', 'fixture'])
}, 60_000)

afterAll(() => {
  if (repoPath) rmSync(repoPath, { recursive: true, force: true })
})

describe('parsePorcelainPaths', () => {
  it('reads the path after the XY status', () => {
    expect(parsePorcelainPaths(' M src/a.ts\n?? new.md\n')).toEqual(['src/a.ts', 'new.md'])
  })

  it('keeps the destination of a rename', () => {
    expect(parsePorcelainPaths('R  old.ts -> src/new.ts')).toEqual(['src/new.ts'])
  })
})

describe('resolveInsideWorktree', () => {
  // An absolute root: `join('/tmp', …)` is not absolute on Windows, and
  // `path.resolve` then prefixes the drive (`D:\tmp\…`).
  const root = join(tmpdir(), 'vertragus-inspect-root')

  it('accepts a relative file', () => {
    expect(resolveInsideWorktree(root, 'src/a.ts')).toBe(join(root, 'src', 'a.ts'))
  })

  it('refuses absolute paths, parent segments and escapes', () => {
    expect(() => resolveInsideWorktree(root, '/etc/passwd')).toThrow(/relative/)
    expect(() => resolveInsideWorktree(root, '..\\secrets')).toThrow(/\.\./)
    expect(() => resolveInsideWorktree(root, '../outside')).toThrow(/\.\./)
    expect(() => resolveInsideWorktree(root, '')).toThrow(/empty/)
  })
})

describe('snapshotWorktree / inspectWorktree', () => {
  it('reports a clean worktree as committed and empty', async () => {
    const created = await createWorktree(repoPath, 'inspect-clean', 'vertragus/inspect/clean')
    const snap = await snapshotWorktree(created.path)
    expect(snap.branch).toBe('vertragus/inspect/clean')
    expect(snap.headSha).toMatch(/^[0-9a-f]{40}$/)
    expect(snap.uncommitted).toBe(false)
    expect(snap.changedFiles).toEqual([])
  }, 30_000)

  it('sees an edited and an untracked file, and serves every view', async () => {
    const created = await createWorktree(repoPath, 'inspect-dirty', 'vertragus/inspect/dirty')
    writeFileSync(join(created.path, 'README.md'), '# changed\n')
    writeFileSync(join(created.path, 'extra.ts'), 'export const n = 1\n')
    mkdirSync(join(created.path, 'src'))
    writeFileSync(join(created.path, 'src', 'nested.ts'), 'export {}\n')

    const snap = await snapshotWorktree(created.path)
    expect(snap.uncommitted).toBe(true)
    expect(snap.changedFiles).toEqual(expect.arrayContaining(['README.md', 'extra.ts', 'src/nested.ts']))

    const status = await inspectWorktree({ worktreePath: created.path, view: 'status' })
    expect(status.body).toMatch(/uncommitted: yes/)
    expect(status.body).toContain('README.md')

    const diff = await inspectWorktree({ worktreePath: created.path, view: 'diff' })
    expect(diff.body).toMatch(/# changed/)
    expect(diff.body).toMatch(/untracked:/)
    expect(diff.body).toContain('extra.ts')

    const log = await inspectWorktree({ worktreePath: created.path, view: 'log', lines: 5 })
    expect(log.body).toMatch(/fixture/)

    const file = await inspectWorktree({
      worktreePath: created.path,
      view: 'file',
      path: 'src/nested.ts'
    })
    expect(file.body).toBe('export {}\n')
  }, 30_000)

  it('scopes the diff and the untracked list to path', async () => {
    const created = await createWorktree(repoPath, 'inspect-scope', 'vertragus/inspect/scope')
    writeFileSync(join(created.path, 'README.md'), '# changed outside\n')
    mkdirSync(join(created.path, 'src'))
    writeFileSync(join(created.path, 'src', 'new.ts'), 'export const inside = 1\n')
    writeFileSync(join(created.path, 'outside.ts'), 'export const outside = 1\n')

    const scoped = await inspectWorktree({
      worktreePath: created.path,
      view: 'diff',
      path: 'src'
    })
    expect(scoped.body).toContain('src/new.ts')
    expect(scoped.body).not.toContain('outside.ts')
    expect(scoped.body).not.toContain('# changed outside')
    // The snapshot around the body stays repository-wide.
    expect(scoped.changedFiles).toEqual(expect.arrayContaining(['README.md', 'outside.ts']))

    const scopedFile = await inspectWorktree({
      worktreePath: created.path,
      view: 'diff',
      path: 'README.md'
    })
    expect(scopedFile.body).toContain('# changed outside')
    expect(scopedFile.body).not.toContain('src/new.ts')

    const nothing = await inspectWorktree({
      worktreePath: created.path,
      view: 'diff',
      path: 'docs'
    })
    expect(nothing.body).toBe('(no tracked diff under docs)')

    await expect(
      inspectWorktree({ worktreePath: created.path, view: 'diff', path: '../README.md' })
    ).rejects.toThrow(/\.\./)
  }, 30_000)

  it('tells the model how to narrow when the diff hits the cap', async () => {
    const created = await createWorktree(repoPath, 'inspect-cap', 'vertragus/inspect/cap')
    const huge = `${'x'.repeat(100)}\n`.repeat(Math.ceil(INSPECT_DIFF_MAX_CHARS / 50))
    writeFileSync(join(created.path, 'README.md'), huge)

    const diff = await inspectWorktree({ worktreePath: created.path, view: 'diff' })
    expect(diff.body).toContain(`truncated at ${INSPECT_DIFF_MAX_CHARS} chars`)
    expect(diff.body).toContain('pass path')
    expect(diff.body).toContain('view "file"')
    expect(diff.body).toContain('view "status"')
  }, 30_000)

  it('refuses a missing file and a path that leaves the worktree', async () => {
    const created = await createWorktree(repoPath, 'inspect-miss', 'vertragus/inspect/miss')
    await expect(
      inspectWorktree({ worktreePath: created.path, view: 'file', path: 'nope.ts' })
    ).rejects.toThrow(/not found/)
    await expect(
      inspectWorktree({ worktreePath: created.path, view: 'file', path: '../README.md' })
    ).rejects.toThrow(/\.\./)
    await expect(inspectWorktree({ worktreePath: created.path, view: 'file' })).rejects.toThrow(
      /needs path/
    )
  }, 30_000)
})
