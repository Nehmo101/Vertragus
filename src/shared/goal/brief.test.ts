import { describe, expect, it } from 'vitest'
import { buildRunContract } from './brief'

const facts = {
  product: 'Demo',
  docs: ['AGENTS.md'],
  scripts: ['test'],
  modules: [{ id: 'core', path: 'src/core' }],
  invariants: ['Never call Math.random'],
  showcases: []
}

describe('buildRunContract', () => {
  it('keeps the user goal verbatim and names the recipe', () => {
    const built = buildRunContract({
      goal: 'ci rot nach dem letzten merge. nur der flake.',
      recipe: 'fix-and-verify',
      repoPath: '/repo',
      questionMode: 'few',
      facts
    })
    expect(built.markdown).toContain('ci rot nach dem letzten merge. nur der flake.')
    expect(built.markdown).toContain('fix-and-verify')
    expect(built.firstTurn).toContain('ci rot nach dem letzten merge. nur der flake.')
    expect(built.preview).toMatch(/^Compiled · fix-and-verify ·/)
    expect(built.json.recipe).toBe('fix-and-verify')
  })

  it('points at brief.md when the journal path is known', () => {
    const built = buildRunContract({
      goal: 'Fix the login bug',
      recipe: 'fix-and-verify',
      repoPath: '/repo',
      questionMode: 'none',
      facts,
      briefPath: '.vertragus/runs/ws-1/brief.md'
    })
    expect(built.firstTurn).toContain('.vertragus/runs/ws-1/brief.md')
  })

  it('does not invent a visual gauntlet for a bugfix recipe', () => {
    const built = buildRunContract({
      goal: 'Fix the login bug',
      recipe: 'fix-and-verify',
      repoPath: '/repo',
      questionMode: 'few',
      facts
    })
    expect(built.markdown).not.toMatch(/≥8\.5/)
    expect(built.markdown).toMatch(/Smallest diff/)
  })
})
