import { describe, expect, it } from 'vitest'
import {
  DEFAULT_CLI_SURFACE,
  effectiveCliSurface,
  isCliSurface,
  normalizeCliSurface
} from './cliSurface'

describe('normalizeCliSurface', () => {
  it('keeps a real surface and defaults everything else', () => {
    expect(normalizeCliSurface('session')).toBe('session')
    expect(normalizeCliSurface('raw')).toBe('raw')
    expect(normalizeCliSurface(undefined)).toBe(DEFAULT_CLI_SURFACE)
    expect(normalizeCliSurface('native')).toBe(DEFAULT_CLI_SURFACE)
    expect(normalizeCliSurface('')).toBe(DEFAULT_CLI_SURFACE)
    expect(DEFAULT_CLI_SURFACE).toBe('session')
  })

  it('is a closed union — the type guard matches normalize', () => {
    expect(isCliSurface('session')).toBe(true)
    expect(isCliSurface('raw')).toBe(true)
    expect(isCliSurface('Session')).toBe(false)
    expect(isCliSurface(null)).toBe(false)
  })
})

describe('effectiveCliSurface', () => {
  it('follows the stored default when nothing peeks', () => {
    expect(effectiveCliSurface({ setting: 'session' })).toBe('session')
    expect(effectiveCliSurface({ setting: 'raw' })).toBe('raw')
    expect(effectiveCliSurface({ setting: 'session', peek: null, boot: 'cli' })).toBe('session')
  })

  it('lets the title-bar peek override the stored default', () => {
    expect(effectiveCliSurface({ setting: 'session', peek: 'raw' })).toBe('raw')
    expect(effectiveCliSurface({ setting: 'raw', peek: 'session' })).toBe('session')
  })

  it('forces raw while MCP is waiting so a leftover Cursor approval is clickable', () => {
    expect(effectiveCliSurface({ setting: 'session', peek: 'session', boot: 'waiting' })).toBe(
      'raw'
    )
    expect(effectiveCliSurface({ setting: 'raw', boot: 'waiting' })).toBe('raw')
  })

  it('does not force raw for the other boot phases — the greyhound overlay covers those', () => {
    expect(effectiveCliSurface({ setting: 'session', boot: 'preparing' })).toBe('session')
    expect(effectiveCliSurface({ setting: 'session', boot: 'handshake' })).toBe('session')
    expect(effectiveCliSurface({ setting: 'session', boot: null })).toBe('session')
  })
})
