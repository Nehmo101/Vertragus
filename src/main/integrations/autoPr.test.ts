import { describe, expect, it } from 'vitest'
import { autoPrInternals } from './autoPr'

describe('autoPr safety helpers', () => {
  it('creates stable safe slugs', () => {
    expect(autoPrInternals.safeSlug('Checkout Flow / API #42')).toBe('checkout-flow-api-42')
    expect(autoPrInternals.safeSlug('***')).toBe('orca-task')
  })

  it('blocks common secret shapes', () => {
    expect(() =>
      autoPrInternals.assertDiffLooksSafe('+ -----BEGIN PRIVATE KEY-----\n+ sensitive')
    ).toThrow(/Secret/)
    expect(() => autoPrInternals.assertDiffLooksSafe('+ const value = "safe"')).not.toThrow()
  })

  it('prefers explicit base branch over profile default', () => {
    expect(autoPrInternals.pickBaseBranch('main', 'develop', 'master')).toBe('main')
    expect(autoPrInternals.pickBaseBranch('', 'develop', 'master')).toBe('develop')
    expect(autoPrInternals.pickBaseBranch('', '', 'master')).toBe('master')
    expect(autoPrInternals.pickBaseBranch('', '', '')).toBe('main')
  })
})
