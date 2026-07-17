import { describe, expect, it } from 'vitest'
import { buildBriefing, tailScrollback } from '@main/agents/handoff'
import type { AgentInstanceInfo } from '@shared/agents'

const ESC = String.fromCharCode(27)

const source: AgentInstanceInfo = {
  id: 'sub-01',
  name: 'Virgilio',
  provider: 'claude',
  model: 'fable',
  role: 'Subagent · Backend / API',
  kind: 'sub',
  mode: 'interactive',
  yolo: false,
  workingDir: '/repo/.orca-worktrees/s/sub-01',
  worktree: '/repo/.orca-worktrees/s/sub-01',
  status: 'running',
  startedAt: 0,
  limitWarning: { kind: 'weekly-fable', detectedAt: 1000, note: 'weekly limit' }
}

describe('tailScrollback', () => {
  it('returns full text when under the cap and strips ANSI', () => {
    const out = tailScrollback(`${ESC}[32mdone${ESC}[0m`, 100)
    expect(out).toBe('done')
  })

  it('keeps only the tail and marks truncation when over the cap', () => {
    const long = 'x'.repeat(50) + 'TAIL_MARKER'
    const out = tailScrollback(long, 11)
    expect(out.startsWith('...(gekürzt)...')).toBe(true)
    expect(out).toContain('TAIL_MARKER')
    // tail body is bounded to maxChars (plus the truncation marker line)
    expect(out.length).toBeLessThan(long.length)
  })
})

describe('buildBriefing', () => {
  const briefing = buildBriefing({
    source,
    targetName: 'Ulisse',
    task: 'Implementiere den /users Endpoint',
    summary: 'Route angelegt, Validierung fehlt noch',
    scrollback: 'line A\nline B\nlast line',
    timestamp: 0
  })

  it('names both agents and the reason', () => {
    expect(briefing).toContain('Virgilio')
    expect(briefing).toContain('Ulisse')
    expect(briefing).toContain('Fable-Wochenlimit')
  })

  it('includes the task, the state note and the scrollback tail', () => {
    expect(briefing).toContain('Implementiere den /users Endpoint')
    expect(briefing).toContain('Validierung fehlt noch')
    expect(briefing).toContain('last line')
  })

  it('bounds the embedded scrollback', () => {
    const big = buildBriefing({
      source,
      targetName: 'Ulisse',
      scrollback: 'A'.repeat(100_000),
      scrollbackChars: 500,
      timestamp: 0
    })
    expect(big).toContain('...(gekürzt)...')
    // Whole briefing stays far below the raw scrollback size.
    expect(big.length).toBeLessThan(3000)
  })

  it('falls back gracefully when task/summary are omitted', () => {
    const b = buildBriefing({ source, targetName: 'Ulisse', scrollback: '', timestamp: 0 })
    expect(b).toContain('Keine explizite Aufgabe')
    expect(b).toContain('(kein Verlauf erfasst)')
  })
})
