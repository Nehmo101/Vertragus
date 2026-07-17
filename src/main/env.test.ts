import { describe, expect, it } from 'vitest'
import { brandEnv } from './env'

describe('brandEnv', () => {
  it('prefers the VERTRAGUS_* name over the ORCA_* legacy name', () => {
    expect(brandEnv('UI_SMOKE', { VERTRAGUS_UI_SMOKE: 'new', ORCA_UI_SMOKE: 'old' })).toBe('new')
  })

  it('falls back to the legacy ORCA_* name', () => {
    expect(brandEnv('UI_SMOKE', { ORCA_UI_SMOKE: 'old' })).toBe('old')
  })

  it('returns undefined when neither is set', () => {
    expect(brandEnv('UI_SMOKE', {})).toBeUndefined()
  })
})
