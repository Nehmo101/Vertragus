import { describe, expect, it } from 'vitest'
import { detectLimit, stripAnsi } from '@main/agents/limitSignals'

const ESC = String.fromCharCode(27)
const color = (s: string): string => `${ESC}[33m${s}${ESC}[0m`

describe('stripAnsi', () => {
  it('removes SGR colour codes but keeps the text', () => {
    expect(stripAnsi(color('You have reached your weekly limit'))).toBe(
      'You have reached your weekly limit'
    )
  })
})

describe('detectLimit', () => {
  it('classifies the 5-hour session limit', () => {
    expect(detectLimit('claude', "You've reached your 5-hour limit. Resets at 3pm.")?.kind).toBe(
      'session-5h'
    )
    expect(detectLimit('claude', '5 hour usage limit reached')?.kind).toBe('session-5h')
  })

  it('classifies the weekly limit', () => {
    expect(detectLimit('claude', 'Approaching your weekly limit')?.kind).toBe('weekly')
  })

  it('classifies the Fable weekly limit distinctly', () => {
    expect(detectLimit('claude', 'Fable weekly limit reached')?.kind).toBe('weekly-fable')
  })

  it('detects a generic usage/rate limit', () => {
    expect(detectLimit('codex', 'Error: usage limit exceeded')?.kind).toBe('generic')
    expect(detectLimit('cursor', 'rate limit hit, please wait')?.kind).toBe('generic')
    expect(detectLimit('claude', 'Nutzungslimit erreicht')?.kind).toBe('generic')
  })

  it('sees through ANSI colour codes', () => {
    const match = detectLimit('claude', color('You have reached your weekly limit'))
    expect(match?.kind).toBe('weekly')
    expect(match?.note).toContain('weekly limit')
  })

  it('returns null for ordinary agent output', () => {
    expect(detectLimit('claude', 'Running tests... 12 passed, 0 failed')).toBeNull()
    expect(detectLimit('codex', 'git commit -m "fix"')).toBeNull()
    expect(detectLimit('claude', 'The rate of change is high')).toBeNull()
  })
})
