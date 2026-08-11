import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { ModelMemory, ProviderConfig } from '@shared/schema/provider'
import { providerPreset } from './presets'
import {
  applyModelMemory,
  collectByPath,
  discoverModels,
  expandHome,
  extractModels,
  familyAliases,
  MEMORY_TTL_MS,
  normalizeModelMemory,
  parseLineModels,
  parseTomlModelKeys,
  type DiscoveryDependencies
} from './discovery'

const FIXTURES = join(__dirname, '__fixtures__')
const fixture = (name: string): string => readFileSync(join(FIXTURES, name), 'utf8')

const NOW = 1_800_000_000_000

function preset(id: string): ProviderConfig {
  const config = providerPreset(id)
  if (!config) throw new Error(`missing preset ${id}`)
  return config
}

/**
 * Fully mocked dependencies — a discovery test must never touch a real CLI,
 * the user's home directory or the network.
 */
function deps(overrides: Partial<DiscoveryDependencies> = {}): {
  deps: Partial<DiscoveryDependencies>
  written: ModelMemory[]
} {
  const written: ModelMemory[] = []
  return {
    written,
    deps: {
      exec: vi.fn(async () => {
        throw new Error('exec not stubbed')
      }),
      readFile: vi.fn(() => {
        throw new Error('ENOENT')
      }),
      homeDir: () => '/home/tester',
      fetchJson: vi.fn(async () => {
        throw new Error('offline')
      }),
      now: () => NOW,
      readMemory: () => ({}),
      writeMemory: (memory) => {
        written.push(memory)
      },
      ...overrides
    }
  }
}

describe('expandHome', () => {
  it('expands a leading tilde on both separators and leaves other paths alone', () => {
    expect(expandHome('~/.claude.json', '/home/t')).toBe('/home/t/.claude.json')
    expect(expandHome('~\\.codex\\x.json', 'C:\\Users\\t')).toBe('C:\\Users\\t\\.codex\\x.json')
    expect(expandHome('~', '/home/t')).toBe('/home/t')
    expect(expandHome('/etc/models.json', '/home/t')).toBe('/etc/models.json')
    expect(expandHome('~notahome/x', '/home/t')).toBe('~notahome/x')
  })
})

describe('collectByPath', () => {
  const doc = {
    models: [{ name: 'a' }, { name: 'b' }],
    table: { one: { id: 'x' }, two: { id: 'y' } },
    nested: { deep: 'value' }
  }

  it('walks plain segments', () => {
    expect(collectByPath(doc, 'nested.deep')).toEqual(['value'])
  })

  it('iterates arrays with []', () => {
    expect(collectByPath(doc, 'models[].name')).toEqual(['a', 'b'])
  })

  it('iterates object VALUES with [] so a list-turned-table still works', () => {
    expect(collectByPath(doc, 'table[].id')).toEqual(['x', 'y'])
  })

  it('returns the root for an empty path and nothing for a missing key', () => {
    expect(collectByPath(doc, undefined)).toEqual([doc])
    expect(collectByPath(doc, 'nope.deeper')).toEqual([])
  })
})

describe('extractModels', () => {
  it('reads ids from strings, entry objects and keyed tables', () => {
    expect(extractModels(['opus'])).toEqual(['opus'])
    expect(extractModels([{ slug: 'gpt-5.6-sol' }])).toEqual(['gpt-5.6-sol'])
    expect(extractModels([{ 'kimi-k3': {}, 'kimi-k2': {} }])).toEqual(['kimi-k3', 'kimi-k2'])
  })

  it('strips ANSI colouring and blank entries', () => {
    const esc = String.fromCharCode(27)
    expect(extractModels([`${esc}[1mopus${esc}[0m`, '   '])).toEqual(['opus'])
  })
})

describe('parseLineModels', () => {
  it('keeps identifiers and drops headers, bullets and prose', () => {
    expect(
      parseLineModels(
        ['Available models:', '  * composer-2.5 - fast agent model', '- auto', '', 'not a model id'].join(
          '\n'
        )
      )
    ).toEqual(['composer-2.5', 'auto'])
  })
})

describe('parseTomlModelKeys', () => {
  it('reads only the [models.*] section keys, quoted or bare', () => {
    expect(parseTomlModelKeys(fixture('kimi-config.toml'))).toEqual(['kimi-code/k3', 'kimi-k3-turbo'])
  })
})

describe('familyAliases', () => {
  it('derives the rolling alias of every single-word family', () => {
    expect(familyAliases(['claude-opus-5', 'claude-sonnet-4-6', 'claude-opus-4-8'])).toEqual([
      'opus',
      'sonnet'
    ])
  })

  it('ignores multi-word product names', () => {
    expect(familyAliases(['kimi-for-coding'])).toEqual([])
  })
})

describe('discoverModels — file sources', () => {
  it('reads the Claude account cache and adds the rolling family aliases', async () => {
    const { deps: overrides } = deps({
      readFile: (path) => {
        expect(path).toBe('/home/tester/.claude.json')
        return fixture('claude-account-cache.json')
      }
    })
    const result = await discoverModels(preset('claude'), overrides)
    expect(result.source).toBe('live')
    expect(result.refreshedAt).toBe(NOW)
    // Alias first, then its pinned release — that is the picker's family order.
    expect(result.models).toEqual([
      'opus',
      'claude-opus-5',
      'sonnet',
      'claude-sonnet-5',
      'haiku',
      'claude-haiku-4-5'
    ])
  })

  it('also reads the cache when the CLI wrote it as a keyed table', async () => {
    const { deps: overrides } = deps({
      readFile: () => fixture('claude-account-cache-record.json')
    })
    const result = await discoverModels(preset('claude'), overrides)
    expect(result.models).toContain('claude-opus-5')
    expect(result.models).toContain('opus')
  })

  it('reads the Codex account catalogue', async () => {
    const { deps: overrides } = deps({
      readFile: (path) => {
        expect(path).toBe('/home/tester/.codex/models_cache.json')
        return fixture('codex-models-cache.json')
      }
    })
    const result = await discoverModels(preset('codex'), overrides)
    expect(result.source).toBe('live')
    expect(result.models).toEqual(['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.5'])
  })

  it('does not derive aliases for non-Claude providers', async () => {
    const { deps: overrides } = deps({ readFile: () => fixture('codex-models-cache.json') })
    const result = await discoverModels(preset('codex'), overrides)
    expect(result.models).not.toContain('gpt')
  })
})

describe('discoverModels — cli sources', () => {
  it('reads the Kimi model table from provider list --json', async () => {
    const exec = vi.fn(async () => fixture('kimi-provider-list.json'))
    const { deps: overrides } = deps({ exec })
    const result = await discoverModels(preset('kimi'), overrides)
    expect(exec).toHaveBeenCalledWith('kimi', ['provider', 'list', '--json'], 8_000)
    expect(result.models).toEqual(['kimi-k3', 'kimi-k3-turbo', 'kimi-code/k3'])
  })

  it('reads the Cursor model list line by line', async () => {
    const exec = vi.fn(async () => 'Available models:\ncomposer-2.5\nauto\n')
    const { deps: overrides } = deps({ exec })
    const result = await discoverModels(preset('cursor'), overrides)
    expect(exec).toHaveBeenCalledWith('cursor-agent', ['models'], 8_000)
    expect(result.models).toEqual(['composer-2.5', 'auto'])
  })
})

describe('discoverModels — http sources', () => {
  it('reads the local Ollama tag list', async () => {
    const fetchJson = vi.fn(async () => JSON.parse(fixture('ollama-tags.json')))
    const { deps: overrides, written } = deps({ fetchJson })
    const result = await discoverModels(preset('ollama'), overrides)
    expect(fetchJson).toHaveBeenCalledWith('http://127.0.0.1:11434/api/tags', 3_000)
    expect(result.models).toEqual(['qwen2.5-coder:32b', 'llama3.3:70b'])
    expect(result.source).toBe('live')
    // A locally deleted model cannot run — local catalogues are never remembered.
    expect(written).toEqual([])
  })

  it('returns nothing (not a stale memory) when the local service is down', async () => {
    const { deps: overrides } = deps({
      readMemory: () => ({ ollama: { 'llama3.3:70b': NOW } })
    })
    const result = await discoverModels(preset('ollama'), overrides)
    expect(result).toEqual({ models: [], source: 'none', refreshedAt: NOW })
  })
})

describe('discoverModels — memory layer', () => {
  it('serves the remembered catalogue when discovery finds nothing', async () => {
    const { deps: overrides } = deps({
      readMemory: () => ({ claude: { opus: NOW - 1_000, 'claude-opus-5': NOW - 1_000 } })
    })
    const result = await discoverModels(preset('claude'), overrides)
    expect(result.source).toBe('memory')
    expect(result.models).toEqual(['opus', 'claude-opus-5'])
  })

  it('forgets ids that have not been seen for 60 days', async () => {
    const { deps: overrides } = deps({
      readMemory: () => ({ claude: { ancient: NOW - MEMORY_TTL_MS - 1, opus: NOW - 1 } })
    })
    const result = await discoverModels(preset('claude'), overrides)
    expect(result.models).toEqual(['opus'])
  })

  it('records what it saw, keyed by provider id, without dropping other providers', async () => {
    const { deps: overrides, written } = deps({
      readFile: () => fixture('codex-models-cache.json'),
      readMemory: () => ({ kimi: { 'kimi-k3': NOW - 5 } })
    })
    await discoverModels(preset('codex'), overrides)
    expect(written).toHaveLength(1)
    expect(written[0]!.kimi).toEqual({ 'kimi-k3': NOW - 5 })
    expect(written[0]!.codex).toMatchObject({ 'gpt-5.6-sol': NOW })
  })

  it('never lets a failing memory write break a refresh', async () => {
    const { deps: overrides } = deps({
      readFile: () => fixture('codex-models-cache.json'),
      writeMemory: () => {
        throw new Error('read-only store')
      }
    })
    await expect(discoverModels(preset('codex'), overrides)).resolves.toMatchObject({
      source: 'live'
    })
  })

  it('ignores a corrupt memory value instead of crashing', () => {
    expect(normalizeModelMemory('nonsense')).toEqual({})
    expect(normalizeModelMemory({ claude: { opus: 'yesterday' } })).toEqual({})
    expect(normalizeModelMemory({ claude: { opus: 12 } })).toEqual({ claude: { opus: 12 } })
  })

  it('merges discovered and remembered ids and refreshes the timestamps', () => {
    const { models, seen } = applyModelMemory(['opus'], { sonnet: NOW - 10 }, NOW)
    expect(models).toEqual(['opus', 'sonnet'])
    expect(seen).toEqual({ opus: NOW, sonnet: NOW - 10 })
  })

  it('does not revive a remembered punctuation twin of a discovered id', () => {
    const { models } = applyModelMemory(
      ['claude-sonnet-4-6'],
      { 'claude-sonnet-4.6': NOW - 10 },
      NOW
    )
    expect(models).toEqual(['claude-sonnet-4-6'])
  })
})

describe('discoverModels — failure handling', () => {
  it('returns an empty result for a provider without discovery', async () => {
    const config = { ...preset('cursor'), modelDiscovery: { kind: 'none' } as const }
    const { deps: overrides, written } = deps()
    expect(await discoverModels(config, overrides)).toEqual({
      models: [],
      source: 'none',
      refreshedAt: NOW
    })
    expect(written).toEqual([])
  })

  it('never throws when the CLI is missing or the cache is unreadable', async () => {
    const { deps: overrides } = deps()
    await expect(discoverModels(preset('kimi'), overrides)).resolves.toEqual({
      models: [],
      source: 'none',
      refreshedAt: NOW
    })
    await expect(discoverModels(preset('claude'), overrides)).resolves.toEqual({
      models: [],
      source: 'none',
      refreshedAt: NOW
    })
  })

  it('survives malformed JSON from a CLI', async () => {
    const { deps: overrides } = deps({ exec: async () => 'not json at all' })
    await expect(discoverModels(preset('kimi'), overrides)).resolves.toMatchObject({
      models: [],
      source: 'none'
    })
  })
})
