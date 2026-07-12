import { describe, expect, it } from 'vitest'
import { parseProviderAuthStatus } from './auth'

describe('parseProviderAuthStatus', () => {
  it('parses Claude JSON without exposing credentials', () => {
    expect(
      parseProviderAuthStatus(
        'claude',
        JSON.stringify({ loggedIn: true, email: 'dev@example.test', authMethod: 'claude.ai' })
      )
    ).toEqual({ connection: 'connected', detail: 'dev@example.test · claude.ai' })
  })

  it('recognizes Codex and Cursor account sessions', () => {
    expect(parseProviderAuthStatus('codex', 'Logged in using ChatGPT').connection).toBe('connected')
    expect(parseProviderAuthStatus('cursor', '✓ Login successful!\nLogged in').connection).toBe(
      'connected'
    )
  })

  it('keeps an explicit disconnected state', () => {
    expect(parseProviderAuthStatus('codex', 'Not logged in').connection).toBe('disconnected')
  })
})
