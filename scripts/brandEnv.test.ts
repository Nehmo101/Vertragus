import { describe, expect, it } from 'vitest'
import { brandEnv } from './brandEnv'

describe('scripts brandEnv', () => {
  it('prefers VERTRAGUS_* over the ORCA_* legacy name', () => {
    expect(
      brandEnv('RETRO_MODEL', {
        VERTRAGUS_RETRO_MODEL: 'vertragus-model',
        ORCA_RETRO_MODEL: 'legacy-model'
      })
    ).toBe('vertragus-model')
  })

  it('falls back to ORCA_* when the canonical name is absent', () => {
    expect(brandEnv('RETRO_MIN_NEW', { ORCA_RETRO_MIN_NEW: '5' })).toBe('5')
  })

  it('does not leak absent secrets or invent values from partial suffixes', () => {
    const env = { ORCA_RETRO_MODEL: 'legacy-model', ANTHROPIC_API_KEY: 'sk-should-not-leak' }
    expect(brandEnv('RETRO_MODEL', env)).toBe('legacy-model')
    expect(brandEnv('GITHUB_OAUTH_CLIENT_ID', env)).toBeUndefined()
    expect(brandEnv('ANTHROPIC_API_KEY', env)).toBeUndefined()
    // brandEnv must never surface unrelated API keys (secret-leak negativ).
    expect(String(brandEnv('ANTHROPIC_API_KEY', env) ?? '')).not.toContain('sk-should-not-leak')
    expect(JSON.stringify(env[`VERTRAGUS_${'ANTHROPIC_API_KEY'}`] ?? null)).not.toContain(
      'sk-should-not-leak'
    )
  })

  it('does not treat unrelated process.env keys as valid brand flags', () => {
    const env = {
      PATH: '/usr/bin',
      ANTHROPIC_API_KEY: 'sk-should-not-leak',
      VERTRAGUS_RETRO_MODEL: 'ok'
    }
    expect(brandEnv('PATH', env)).toBeUndefined()
    expect(brandEnv('RETRO_MODEL', env)).toBe('ok')
    expect(brandEnv('', env)).toBeUndefined()
  })
})
