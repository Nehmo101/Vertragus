import { describe, expect, it, vi } from 'vitest'
import {
  MEMORY_TTL_MS,
  applyModelMemory,
  claudeFamilyAliases,
  listModels,
  normalizeModelMemory,
  parseAnthropicModelList,
  parseClaudeAccountCache,
  parseCodexModelCache,
  parseCopilotHelpModels,
  parseCursorModels,
  type ModelCatalogMemory
} from './models'

const NOW = Date.parse('2026-07-29T09:00:00Z')

/**
 * Discovery deps with no ambient state: no provider keys in the environment
 * (so no live API call), a fixed clock, and an in-memory remembered catalogue.
 * Without this a test would read and write the real config store and leak its
 * models into the next case.
 */
function isolated(memory: ModelCatalogMemory = {}): {
  env: () => undefined
  now: () => number
  readMemory: () => ModelCatalogMemory
  writeMemory: (next: ModelCatalogMemory) => void
  written: ModelCatalogMemory[]
} {
  const written: ModelCatalogMemory[] = []
  return {
    env: () => undefined,
    now: () => NOW,
    readMemory: () => memory,
    writeMemory: (next) => {
      written.push(next)
    },
    written
  }
}

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
      },
      ...isolated()
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
      },
      ...isolated()
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
      },
      ...isolated()
    })

    expect(catalog.copilot).toMatchObject({
      models: ['claude-sonnet-4.6', 'gpt-5.4', 'claude-haiku-4.5'],
      source: 'live',
      accountDependent: true
    })
    expect(exec).not.toHaveBeenCalledWith('copilot', ['models'], expect.any(Number))
  })
})

describe('Anthropic model list', () => {
  it('reads ids out of the API envelope and ignores junk', () => {
    expect(
      parseAnthropicModelList({
        data: [
          { id: 'claude-opus-5', display_name: 'Claude Opus 5' },
          { id: 'claude-titan-5' },
          { id: 'claude-opus-5' },
          { display_name: 'no id' },
          null
        ]
      })
    ).toEqual(['claude-opus-5', 'claude-titan-5'])
    expect(parseAnthropicModelList({})).toEqual([])
    expect(parseAnthropicModelList('nope')).toEqual([])
  })

  it('derives the rolling alias of every family, including unreleased ones', () => {
    // This is what makes a brand-new family usable without a Vertragus update.
    expect(claudeFamilyAliases(['claude-opus-5', 'claude-haiku-4-5', 'claude-titan-5'])).toEqual([
      'opus',
      'haiku',
      'titan'
    ])
  })

  it('skips ids that are not Claude models', () => {
    expect(claudeFamilyAliases(['gpt-5.6-sol', 'auto'])).toEqual([])
  })

  it('queries the API when a key exists and offers the aliases it implies', async () => {
    const fetchJson = vi.fn(async (url: string, _timeoutMs: number, headers?: Record<string, string>) => {
      expect(url).toContain('/v1/models')
      expect(headers?.['x-api-key']).toBe('sk-test')
      expect(headers?.['anthropic-version']).toBe('2023-06-01')
      return { data: [{ id: 'claude-titan-5' }, { id: 'claude-opus-5' }] }
    })

    const catalog = await listModels({
      exec: async () => {
        throw new Error('unavailable')
      },
      readFile: () => {
        throw new Error('missing')
      },
      homeDir: () => '/home/test',
      fetchJson,
      ...isolated(),
      env: (name) => (name === 'ANTHROPIC_API_KEY' ? 'sk-test' : undefined)
    })

    expect(catalog.claude.source).toBe('live')
    // A model released after this build is offered, and so is its alias.
    expect(catalog.claude.models).toEqual(expect.arrayContaining(['titan', 'claude-titan-5']))
    expect(catalog.claude.models.indexOf('titan')).toBeLessThan(
      catalog.claude.models.indexOf('claude-titan-5')
    )
    expect(catalog.claude.refreshedAt).toBe(NOW)
  })

  it('sends an OAuth token as a bearer credential instead of an API key', async () => {
    const fetchJson = vi.fn(async (_url: string, _timeoutMs: number, headers?: Record<string, string>) => {
      expect(headers?.Authorization).toBe('Bearer oat-test')
      expect(headers?.['anthropic-beta']).toBe('oauth-2025-04-20')
      expect(headers?.['x-api-key']).toBeUndefined()
      return { data: [{ id: 'claude-opus-5' }] }
    })

    await listModels({
      exec: async () => {
        throw new Error('unavailable')
      },
      readFile: () => {
        throw new Error('missing')
      },
      homeDir: () => '/home/test',
      fetchJson,
      ...isolated(),
      env: (name) => (name === 'ANTHROPIC_AUTH_TOKEN' ? 'oat-test' : undefined)
    })

    expect(fetchJson).toHaveBeenCalled()
  })

  it('never calls the model API without a credential', async () => {
    const fetchJson = vi.fn(async (url: string) => {
      // Only the local Ollama probe may run.
      expect(url).toContain('localhost:11434')
      throw new Error('offline')
    })

    await listModels({
      exec: async () => {
        throw new Error('unavailable')
      },
      readFile: () => {
        throw new Error('missing')
      },
      homeDir: () => '/home/test',
      fetchJson,
      ...isolated()
    })

    for (const call of fetchJson.mock.calls) expect(call[0]).not.toContain('api.anthropic.com')
  })
})

describe('remembered catalogue', () => {
  it('drops corrupt persisted values', () => {
    expect(normalizeModelMemory(undefined)).toEqual({})
    expect(normalizeModelMemory([1, 2])).toEqual({})
    expect(normalizeModelMemory({ claude: { opus: 'yesterday' } })).toEqual({})
    expect(normalizeModelMemory({ claude: { opus: NOW }, nope: { x: NOW } })).toEqual({
      claude: { opus: NOW }
    })
  })

  it('refreshes the timestamp of every currently discovered model', () => {
    const { entry, seen } = applyModelMemory(
      'claude',
      { models: ['opus'], source: 'live', accountDependent: true },
      { claude: { opus: NOW - 1_000, sonnet: NOW - 2_000 } },
      NOW
    )
    expect(seen.opus).toBe(NOW)
    expect(seen.sonnet).toBe(NOW - 2_000)
    // A remembered-but-undiscovered model stays selectable.
    expect(entry.models).toEqual(['opus', 'sonnet'])
    expect(entry.detail).toContain('1 zuletzt gesehene')
  })

  it('serves the picker from memory when discovery returns nothing', () => {
    const { entry } = applyModelMemory(
      'codex',
      { models: [], source: 'unavailable', accountDependent: true, detail: 'nichts' },
      { codex: { 'gpt-5.6-sol': NOW - 1_000 } },
      NOW
    )
    expect(entry).toMatchObject({ models: ['gpt-5.6-sol'], source: 'fallback' })
    expect(entry.detail).toContain('zuletzt gesehene')
  })

  it('forgets models that were not seen again within the TTL', () => {
    const { entry, seen } = applyModelMemory(
      'claude',
      { models: ['opus'], source: 'live', accountDependent: true },
      { claude: { opus: NOW - 1_000, 'claude-opus-4-1': NOW - MEMORY_TTL_MS - 1 } },
      NOW
    )
    expect(entry.models).toEqual(['opus'])
    expect(seen['claude-opus-4-1']).toBeUndefined()
  })

  it('never revives local Ollama models — a pulled-away model cannot run', () => {
    const { entry, seen } = applyModelMemory(
      'ollama',
      { models: ['qwen2.5-coder:32b'], source: 'live', accountDependent: false },
      { claude: { opus: NOW } },
      NOW
    )
    expect(entry.models).toEqual(['qwen2.5-coder:32b'])
    expect(seen).toEqual({})
  })

  it('keeps the picker stable across a refresh that finds less than the last one', async () => {
    const deps = {
      exec: async () => {
        throw new Error('unavailable')
      },
      readFile: () => {
        throw new Error('missing')
      },
      homeDir: () => '/home/test',
      fetchJson: async () => {
        throw new Error('offline')
      }
    }
    const first = isolated()
    await listModels({ ...deps, ...first })
    const remembered = first.written.at(-1) ?? {}
    expect(Object.keys(remembered.claude ?? {})).toContain('opus')

    const second = isolated(remembered)
    const catalog = await listModels({ ...deps, ...second })
    expect(catalog.claude.models).toEqual(expect.arrayContaining(['opus', 'sonnet']))
    expect(catalog.claude.refreshedAt).toBe(NOW)
  })
})
