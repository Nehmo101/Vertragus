import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_PROVIDER_LIMITS, type AgentProviderId } from '@shared/providers'
import { getSetting } from '@main/config/store'
import { ProviderLimitError, providerCapacity } from '@main/agents/providerCapacity'

vi.mock('@main/config/store', () => ({
  getSetting: vi.fn(() => undefined)
}))

const PROVIDERS = Object.keys(DEFAULT_PROVIDER_LIMITS) as AgentProviderId[]

function drainCapacity(): void {
  for (const provider of PROVIDERS) {
    let { active } = providerCapacity.stats(provider)
    while (active-- > 0) providerCapacity.release(provider)
  }
}

describe('providerCapacity', () => {
  afterEach(() => {
    drainCapacity()
    vi.mocked(getSetting).mockReturnValue(undefined)
    providerCapacity.refreshLimits()
  })

  it('rejects interactive acquire when the provider limit is full', () => {
    providerCapacity.tryAcquire('claude')
    providerCapacity.tryAcquire('claude')
    providerCapacity.tryAcquire('claude')
    providerCapacity.tryAcquire('claude')

    expect(() => providerCapacity.tryAcquire('claude')).toThrow(ProviderLimitError)
    expect(providerCapacity.stats('claude').active).toBe(4)
  })

  it('queues headless acquires and releases slots in order', async () => {
    providerCapacity.tryAcquire('ollama')
    providerCapacity.tryAcquire('ollama')

    const waiter = providerCapacity.acquireWait('ollama')
    expect(providerCapacity.stats('ollama').waiting).toBe(1)

    providerCapacity.release('ollama')
    await waiter
    expect(providerCapacity.stats('ollama').active).toBe(2)
  })

  it('does not evict running agents when the limit is lowered', () => {
    providerCapacity.tryAcquire('cursor')
    providerCapacity.tryAcquire('cursor')

    vi.mocked(getSetting).mockReturnValue({ cursor: 1 })
    providerCapacity.refreshLimits()

    expect(providerCapacity.stats('cursor').active).toBe(2)
    expect(() => providerCapacity.tryAcquire('cursor')).toThrow(ProviderLimitError)
  })

  it('falls back to safe defaults for corrupt persisted gate values', () => {
    vi.mocked(getSetting).mockReturnValue({ claude: 0, cursor: Number.POSITIVE_INFINITY })
    providerCapacity.refreshLimits()

    expect(providerCapacity.stats('claude').limit).toBe(DEFAULT_PROVIDER_LIMITS.claude)
    expect(providerCapacity.stats('cursor').limit).toBe(DEFAULT_PROVIDER_LIMITS.cursor)
  })

  it('aborts a queued waiter without consuming a slot', async () => {
    providerCapacity.tryAcquire('ollama')
    providerCapacity.tryAcquire('ollama')

    const signal = { aborted: false }
    const waiter = providerCapacity.acquireWait('ollama', signal)
    signal.aborted = true
    providerCapacity.release('ollama')

    const acquired = await waiter
    expect(acquired).toBe(false)
    expect(providerCapacity.stats('ollama').active).toBe(1)
  })
})
