import { describe, expect, it, vi } from 'vitest'
import type { ProviderConfig } from '@shared/schema/provider'
import { providerPreset, providerPresets } from './presets'
import { checkAllProviders, checkProvider, firstLine, type HealthDependencies } from './health'

const NOW = 1_800_000_000_000

function preset(id: string): ProviderConfig {
  const config = providerPreset(id)
  if (!config) throw new Error(`missing preset ${id}`)
  return config
}

function deps(overrides: Partial<HealthDependencies> = {}): Partial<HealthDependencies> {
  return {
    exec: vi.fn(async () => {
      throw new Error('spawn claude ENOENT')
    }),
    fetchJson: vi.fn(async () => {
      throw new Error('offline')
    }),
    now: () => NOW,
    ...overrides
  }
}

describe('firstLine', () => {
  it('returns the first non-empty trimmed line', () => {
    expect(firstLine('\n\n  2.1.4 (Claude Code)  \nmore\n')).toBe('2.1.4 (Claude Code)')
    expect(firstLine('   ')).toBe('')
  })
})

describe('checkProvider', () => {
  it('reports the version from the declared probe args', async () => {
    const exec = vi.fn(async () => '2.1.4 (Claude Code)\n')
    const health = await checkProvider(preset('claude'), deps({ exec }))
    expect(exec).toHaveBeenCalledWith('claude', ['--version'], 6_000)
    expect(health).toEqual({
      id: 'claude',
      available: true,
      version: '2.1.4 (Claude Code)',
      checkedAt: NOW
    })
  })

  it('reports an uninstalled CLI as unavailable instead of throwing', async () => {
    const health = await checkProvider(preset('cursor'), deps())
    expect(health.available).toBe(false)
    expect(health.error).toMatch(/ENOENT/)
    expect(health.version).toBeUndefined()
  })

  it('probes a custom provider with its own version args', async () => {
    const exec = vi.fn(async () => 'acme 0.9')
    const config: ProviderConfig = { ...preset('cursor'), id: 'acme', presetId: undefined, command: 'acme', versionArgs: ['version', '--short'] }
    await checkProvider(config, deps({ exec }))
    expect(exec).toHaveBeenCalledWith('acme', ['version', '--short'], 6_000)
  })

  it('never throws on a non-Error rejection', async () => {
    const health = await checkProvider(
      preset('kimi'),
      deps({
        exec: async () => {
          throw 'boom'
        }
      })
    )
    expect(health).toMatchObject({ available: false, error: 'boom' })
  })
})

describe('checkProvider — ollama is a service, not just a binary', () => {
  it('counts the local models when the daemon answers', async () => {
    const exec = vi.fn(async () => 'ollama version 0.6.2')
    const fetchJson = vi.fn(async () => ({ models: [{ name: 'a' }, { name: 'b' }] }))
    const health = await checkProvider(preset('ollama'), deps({ exec, fetchJson }))
    expect(fetchJson).toHaveBeenCalledWith('http://127.0.0.1:11434/api/tags', 3_000)
    expect(health).toMatchObject({
      id: 'ollama',
      available: true,
      version: 'ollama version 0.6.2',
      detail: '2 local models'
    })
  })

  it('is unavailable when the CLI exists but the daemon is down', async () => {
    const exec = vi.fn(async () => 'ollama version 0.6.2')
    const health = await checkProvider(preset('ollama'), deps({ exec }))
    expect(health).toMatchObject({
      available: false,
      detail: 'local service unreachable',
      error: 'local service unreachable'
    })
  })

  it('keeps the CLI error when neither the binary nor the daemon answers', async () => {
    const health = await checkProvider(preset('ollama'), deps())
    expect(health.available).toBe(false)
    expect(health.error).toMatch(/ENOENT/)
  })
})

describe('checkAllProviders', () => {
  it('probes every provider in parallel and preserves the order', async () => {
    let running = 0
    let peak = 0
    const exec = vi.fn(async () => {
      running += 1
      peak = Math.max(peak, running)
      await Promise.resolve()
      running -= 1
      return '1.0.0'
    })
    const configs = providerPresets()
    const results = await checkAllProviders(configs, deps({ exec, fetchJson: async () => ({ models: [] }) }))
    expect(results.map((entry) => entry.id)).toEqual(configs.map((entry) => entry.id))
    expect(peak).toBeGreaterThan(1)
    expect(results.every((entry) => entry.available)).toBe(true)
  })

  it('returns an empty list for an empty provider set', async () => {
    expect(await checkAllProviders([], deps())).toEqual([])
  })
})
