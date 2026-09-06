import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { compileGoal } from './compileGoal'

const dirs: string[] = []

function tempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'vertragus-goal-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('compileGoal', () => {
  it('off returns the raw goal and does not probe', async () => {
    const compiled = await compileGoal({
      goal: '  Fix the login bug  ',
      repoPath: join(tmpdir(), 'does-not-exist-vertragus-goal'),
      mode: 'off',
      questionMode: 'few'
    })
    expect(compiled.firstTurn).toBe('Fix the login bug')
    expect(compiled.preview).toBeUndefined()
    expect(compiled.markdown).toBeUndefined()
  })

  it('cheap wraps a bugfix with fix-and-verify and keeps the verbatim goal', async () => {
    const repo = tempRepo()
    writeFileSync(
      join(repo, 'AGENTS.md'),
      '# Demo\n\n- Never call Math.random\n- Must not leak secrets\n'
    )
    writeFileSync(join(repo, 'package.json'), JSON.stringify({ scripts: { test: 'vitest', lint: 'eslint .' } }))
    mkdirSync(join(repo, 'src'))

    const compiled = await compileGoal({
      goal: 'Fix the login bug',
      repoPath: repo,
      mode: 'cheap',
      questionMode: 'few',
      briefPath: '.vertragus/runs/ws-1/brief.md'
    })
    expect(compiled.recipe).toBe('fix-and-verify')
    expect(compiled.firstTurn).toContain('Fix the login bug')
    expect(compiled.firstTurn).toContain('fix-and-verify')
    expect(compiled.firstTurn).not.toBe('Fix the login bug')
    expect(compiled.preview).toMatch(/Compiled · fix-and-verify/)
    expect(compiled.markdown).toContain('Never call Math.random')
    expect(compiled.json?.verify.tests).toContain('test')
  })

  it('honours a playbook recipe override', async () => {
    const compiled = await compileGoal({
      goal: 'look at the calendar sync',
      repoPath: tempRepo(),
      mode: 'cheap',
      questionMode: 'none',
      recipe: 'docs-only'
    })
    expect(compiled.recipe).toBe('docs-only')
    expect(compiled.firstTurn).toContain('docs-only')
  })

  it('scout lists nested apps without throwing on an empty repo', async () => {
    const repo = tempRepo()
    mkdirSync(join(repo, 'apps', 'studio'), { recursive: true })
    writeFileSync(join(repo, 'README.md'), '# UWE\n')
    const compiled = await compileGoal({
      goal: 'portal notes must never leak dm_only titles',
      repoPath: repo,
      mode: 'scout',
      questionMode: 'few'
    })
    expect(compiled.recipe).toBe('invariant-first')
    expect(compiled.json?.modules.some((module) => module.path === 'apps/studio')).toBe(true)
  })
})
