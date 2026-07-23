import { describe, expect, it } from 'vitest'
import { headlessStartupLines, isHeadlessMode } from './headlessMode'

describe('headless mode', () => {
  it('activates on VERTRAGUS_HEADLESS=1/true and the ORCA_* legacy alias', () => {
    expect(isHeadlessMode({ VERTRAGUS_HEADLESS: '1' })).toBe(true)
    expect(isHeadlessMode({ VERTRAGUS_HEADLESS: 'true' })).toBe(true)
    expect(isHeadlessMode({ ORCA_HEADLESS: '1' })).toBe(true)
    expect(isHeadlessMode({ VERTRAGUS_HEADLESS: '0' })).toBe(false)
    expect(isHeadlessMode({})).toBe(false)
  })

  it('warns loudly when the host would be unreachable without Mission Control', () => {
    expect(headlessStartupLines(true).join('\n')).toContain('Mission-Control-Gateway')
    const warned = headlessStartupLines(false).join('\n')
    expect(warned).toContain('WARNUNG')
    expect(warned).toContain('nicht fernsteuerbar')
  })
})
