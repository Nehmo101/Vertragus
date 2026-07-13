import { describe, expect, it, vi } from 'vitest'
import {
  listModels,
  parseClaudeAccountCache,
  parseCodexModelCache,
  parseCopilotHelpModels,
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
    ).toEqual(['composer-2.5'])
  })

  it('reads the model identifiers advertised by Copilot help', () => {
    expect(
      parseCopilotHelpModels(
        'Supported models:\n  claude-sonnet-4.6 - default\n  gpt-5.4\n  gemini-3.5-flash\n'
      )
    ).toEqual(['claude-sonnet-4.6', 'gpt-5.4', 'gemini-3.5-flash'])
  })

  it('uses complete live catalogues but augments Claude partial cache options', async () => {
    const exec = vi.fn(async (command: string, args: string[]) => {
      if (command === 'cursor-agent' && args[0] === 'models') {
        return 'Available models:\ncomposer-2.5 - Composer'
      }
      if (command === 'copilot' && args[0] === 'help') {
        return 'Supported models:\nclaude-sonnet-4.6\ngpt-5.4'
      }
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
      source: 'mixed'
    })
    expect(catalog.claude.models).toEqual(
      expect.arrayContaining(['sonnet', 'opus', 'haiku', 'fable', 'claude-fable-5'])
    )
    expect(catalog.copilot).toMatchObject({
      models: ['claude-sonnet-4.6', 'gpt-5.4'],
      source: 'live'
    })
    expect(catalog.ollama.source).toBe('fallback')
  })

  it('keeps useful Claude and Cursor suggestions when live discovery fails', async () => {
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

    expect(catalog.cursor).toMatchObject({
      models: expect.arrayContaining(['auto', 'composer-2.5']),
      source: 'fallback',
      accountDependent: true,
      detail: expect.stringMatching(/Vorschläge/)
    })
    expect(catalog.claude).toMatchObject({
      models: expect.arrayContaining(['sonnet', 'opus', 'haiku', 'fable']),
      source: 'fallback',
      accountDependent: true,
      detail: expect.stringMatching(/Aliase/)
    })
  })

  it('uses Copilot model IDs from CLI help without invoking a nonexistent models subcommand', async () => {
    const exec = vi.fn(async (command: string, args: string[]) => {
      if (command === 'copilot' && args[0] === 'help') {
        return 'Supported models:\nclaude-sonnet-4.6\ngpt-5.4\nclaude-haiku-4.5'
      }
      throw new Error('unavailable')
    })
    const catalog = await listModels({
      exec,
      readFile: () => {
        throw new Error('missing')
      },
      homeDir: () => '/home/test',
      fetchJson: async () => {
        throw new Error('offline')
      }
    })

    expect(catalog.copilot).toMatchObject({
      models: ['claude-sonnet-4.6', 'gpt-5.4', 'claude-haiku-4.5'],
      source: 'live',
      accountDependent: true
    })
    expect(exec).not.toHaveBeenCalledWith('copilot', ['models'], expect.any(Number))
  })
})
