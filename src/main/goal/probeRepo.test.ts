import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { probeRepo } from './probeRepo'

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('probeRepo', () => {
  it('cheap reads AGENTS.md and package scripts, skips node_modules', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'vertragus-probe-'))
    dirs.push(repo)
    writeFileSync(join(repo, 'AGENTS.md'), '# App\n\n- Never rewrite auth\n')
    writeFileSync(join(repo, 'package.json'), JSON.stringify({ scripts: { test: 'vitest', build: 'vite' } }))
    mkdirSync(join(repo, 'src'))
    mkdirSync(join(repo, 'node_modules'))

    const facts = await probeRepo(repo, 'cheap')
    expect(facts.product).toBe('App')
    expect(facts.docs).toEqual(['AGENTS.md'])
    expect(facts.scripts).toEqual(['test', 'build'])
    expect(facts.modules.map((module) => module.id)).toContain('src')
    expect(facts.modules.map((module) => module.id)).not.toContain('node_modules')
    expect(facts.invariants.some((line) => /Never rewrite auth/.test(line))).toBe(true)
  })

  it('returns empty facts for a missing path', async () => {
    const facts = await probeRepo(join(tmpdir(), 'vertragus-probe-missing'), 'scout')
    expect(facts.docs).toEqual([])
    expect(facts.modules).toEqual([])
  })
})
