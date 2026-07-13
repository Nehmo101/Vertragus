import { describe, expect, it, vi } from 'vitest'
import {
  listModels,
  parseClaudeAccountCache,
  parseCodexModelCache,
  parseCursorModels
} from './models'

describe('model catalogue discovery', () => {
  it('reads exact account-exposed Codex slugs and excludes hidden entries', () => {
    expect(
      parseCodexModelCache(
        JSON.stringify({
          models: [
            { slug: 'gpt-5.6-sol', visibility: 'list' },
            { slug: 'gpt-5.6-terra', visibility: 'list' },
            { slug: 'codex-auto-review', visibility: 'hide' },
            { slug: 'gpt-5.6-sol', visibility: 'list' }
          ]
        })
      )
    ).toEqual(['gpt-5.6-sol', 'gpt-5.6-terra'])
  })

  it('reads Claude Fable account options and strips terminal suffixes', () => {
    expect(
      parseClaudeAccountCache(
        JSON.stringify({
          additionalModelOptionsCache: {
            value: 'claude-fable-5[1m]',
            label: 'Fable'
          },
          modelAccessCache: []
        })
      )
    ).toEqual(['claude-fable-5', 'fable'])
  })

  it('keeps only live Cursor CLI identifiers', () => {
    expect(
      parseCursorModels(
        'Available models:\nNot authenticated\nFailed to load models:\n* composer-2.5 - Composer\n'
      )
    ).toEqual([
      'composer-2.5'
    ])
  })

  it('does not merge live catalogues with dead defaults', async () => {
    const exec = vi.fn(async (command: string, args: string[]) => {
      if (command === 'cursor-agent' && args[0] === 'models') {
        return 'Available models:\ncomposer-2.5 - Composer'
      }
      if (command === 'copilot' && args[0] === '--help') return 'Commands:\n  auth  Login'
      throw new Error('unexpected command')
    })
    const readFile = vi.fn((path: string) => {
      const normalized = path.replace(/\\/g, '/')
      if (normalized.endsWith('/.codex/models_cache.json')) {
        return JSON.stringify({
          models: [
            { slug: 'gpt-5.6-sol', visibility: 'list' },
            { slug: 'gpt-5.6-terra', visibility: 'list' }
          ]
        })
      }
      if (normalized.endsWith('/.claude.json')) {
        return JSON.stringify({
          additionalModelOptionsCache: { value: 'claude-fable-5[1m]', label: 'Fable' }
        })
      }
      if (normalized.endsWith('/.claude/settings.json')) return JSON.stringify({ model: 'opus' })
      throw new Error('missing')
    })

    const catalog = await listModels({
      exec,
      readFile,
      homeDir: () => '/home/test',
      fetchJson: async () => {
        throw new Error('offline')
      }
    })

    expect(catalog.codex).toMatchObject({
      models: ['gpt-5.6-sol', 'gpt-5.6-terra'],
      source: 'live',
      accountDependent: true
    })
    expect(catalog.cursor).toMatchObject({
      models: ['composer-2.5'],
      source: 'live',
      accountDependent: true
    })
    expect(catalog.claude).toMatchObject({
      models: ['claude-fable-5', 'fable'],
      source: 'live'
    })
    expect(catalog.ollama.source).toBe('fallback')
  })

  it('returns Cursor unavailable instead of guessed models when discovery fails', async () => {
    const catalog = await listModels({
      exec: async () => {
        throw new Error('not logged in')
      },
      readFile: () => {
        throw new Error('missing')
      },
      homeDir: () => '/home/test',
      fetchJson: async () => {
        throw new Error('offline')
      }
    })

    expect(catalog.cursor).toEqual({
      models: [],
      source: 'unavailable',
      accountDependent: true,
      detail: expect.stringMatching(/nicht verfügbar|nicht angemeldet/)
    })
    expect(catalog.claude).toEqual({
      models: [],
      source: 'unavailable',
      accountDependent: true,
      detail: expect.stringMatching(/kein Berechtigungsnachweis/)
    })
  })

  it('uses Copilot live output only when the CLI advertises a model-list command', async () => {
    const catalog = await listModels({
      exec: async (command, args) => {
        if (command === 'copilot' && args[0] === '--help') return 'Commands:\n  models  List account models'
        if (command === 'copilot' && args[0] === 'models') return 'claude-sonnet-4.5\ngpt-5'
        throw new Error('unavailable')
      },
      readFile: () => {
        throw new Error('missing')
      },
      homeDir: () => '/home/test',
      fetchJson: async () => {
        throw new Error('offline')
      }
    })

    expect(catalog.copilot).toMatchObject({
      models: ['claude-sonnet-4.5', 'gpt-5'],
      source: 'live',
      accountDependent: true
    })
  })
})
