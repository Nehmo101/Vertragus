import { describe, expect, it } from 'vitest'
import {
  buildCustomProviderLaunch,
  CUSTOM_PROVIDER_PREFIX,
  isCustomProviderId,
  parseCustomProviders,
  type CustomProviderConfig
} from './customProviders'

function raw(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: 'custom:acme', label: 'Acme CLI', command: 'acme', ...overrides }
}

describe('custom providers', () => {
  it('normalizes ids under the custom: namespace and applies defaults', () => {
    const [provider] = parseCustomProviders([raw({ id: 'Acme Bot' })])
    expect(provider.id).toBe('custom:acme-bot')
    expect(provider).toMatchObject({
      promptDelivery: 'arg',
      roles: ['worker'],
      streamJson: false,
      enabled: true,
      args: [],
      yoloArgs: []
    })
    expect(isCustomProviderId(provider.id)).toBe(true)
  })

  it('rejects entries that shadow a built-in provider id', () => {
    expect(parseCustomProviders([raw({ id: 'claude' })])).toHaveLength(0)
    expect(parseCustomProviders([raw({ id: 'custom:codex' })])).toHaveLength(0)
    expect(parseCustomProviders([raw({ id: 'CURSOR' })])).toHaveLength(0)
  })

  it('drops invalid rows and duplicates without throwing', () => {
    const providers = parseCustomProviders([
      raw({ id: 'custom:a' }),
      { id: 'custom:b' }, // missing command/label → dropped
      raw({ id: 'custom:a', label: 'dup' }) // duplicate id → first wins
    ])
    expect(providers.map((provider) => provider.id)).toEqual(['custom:a'])
    expect(providers[0].label).toBe('Acme CLI')
  })

  it('places the prompt as the final argument by default', () => {
    const config = parseCustomProviders([raw({ args: ['run', '--json'], yoloArgs: ['--yes'] })])[0]
    const launch = buildCustomProviderLaunch(config, { prompt: 'do the thing', yolo: false })
    expect(launch).toEqual({ command: 'acme', args: ['run', '--json', 'do the thing'] })
  })

  it('routes the prompt to stdin and appends yolo args only when in yolo mode', () => {
    const config: CustomProviderConfig = parseCustomProviders([
      raw({ promptDelivery: 'stdin', args: ['chat'], yoloArgs: ['--dangerous'], streamJson: true })
    ])[0]
    const launch = buildCustomProviderLaunch(config, { prompt: 'PROMPT', yolo: true })
    expect(launch).toEqual({
      command: 'acme',
      args: ['chat', '--output-format', 'stream-json', '--dangerous'],
      stdin: 'PROMPT'
    })
  })

  it('never offers an orchestrator role', () => {
    expect(parseCustomProviders([raw({ roles: ['orchestrator'] })])).toHaveLength(0)
    expect(CUSTOM_PROVIDER_PREFIX).toBe('custom:')
  })
})
