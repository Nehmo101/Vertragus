import { afterEach, expect, it, vi } from 'vitest'
import { providerPreset } from './presets'
import { preflightSeat, type SeatPreflightDependencies } from './preflightSeat'

const provider = { ...providerPreset('codex')!, modelDiscovery: { kind: 'cli' as const, args: ['models'], parse: 'lines' as const } }
const seat = { providerId: provider.id, model: 'model-a', effort: 'high' as const }
const deps: SeatPreflightDependencies = {
  health: async () => ({ id: provider.id, available: true, checkedAt: 0 }),
  auth: async () => ({ id: provider.id, state: 'unknown', checkedAt: 0 }),
  models: async () => ({ models: ['model-a'], source: 'live', refreshedAt: 0, efforts: { 'model-a': ['high'] } })
}
afterEach(() => vi.useRealTimers())

it('accepts a healthy seat without inventing an authentication verdict', async () => {
  await expect(preflightSeat(provider, seat, deps)).resolves.toBeUndefined()
})
it('rejects a missing CLI and known logged-out account', async () => {
  await expect(preflightSeat(provider, seat, { ...deps, health: async () => ({ id: provider.id, available: false, error: 'missing CLI', checkedAt: 0 }) })).rejects.toThrow('missing CLI')
  await expect(preflightSeat(provider, seat, { ...deps, auth: async () => ({ id: provider.id, state: 'logged-out', loginCommand: 'codex login', checkedAt: 0 }) })).rejects.toThrow('codex login')
})
it('checks authoritative model and per-model effort lists but accepts incomplete catalogues', async () => {
  await expect(preflightSeat(provider, { ...seat, model: 'other' }, deps)).rejects.toThrow('does not offer model')
  await expect(preflightSeat(provider, { ...seat, effort: 'low' }, deps)).rejects.toThrow('does not support effort')
  await expect(preflightSeat(provider, { ...seat, model: 'other', effort: undefined }, { ...deps, models: async () => ({ models: ['model-a'], source: 'memory', refreshedAt: 0 }) })).resolves.toBeUndefined()
})
it('bounds unavailable auth and discovery to six seconds', async () => {
  vi.useFakeTimers()
  const unknown = () => new Promise<never>(() => undefined)
  const pending = preflightSeat(provider, { providerId: provider.id }, { ...deps, auth: unknown, models: unknown })
  await vi.advanceTimersByTimeAsync(6_000)
  await expect(pending).resolves.toBeUndefined()
})
it('rejects an unverified CLI, mismatched descriptor, and unsupported explicit effort', async () => {
  await expect(preflightSeat(provider, { providerId: 'other' }, deps)).rejects.toThrow('descriptor')
  await expect(preflightSeat(provider, seat, { ...deps, health: async () => { throw new Error('failed') } })).rejects.toThrow('availability')
  await expect(preflightSeat({ ...provider, effortArg: undefined }, seat, deps)).rejects.toThrow('explicit effort')
})

it('uses declared fallback efforts when discovery cannot answer and refuses an unknown rung', async () => {
  const missingCatalogue = { ...deps, models: async () => { throw new Error('offline catalogue') } }
  await expect(preflightSeat({ ...provider, effortLevels: ['high'] }, seat, missingCatalogue)).resolves.toBeUndefined()
  await expect(preflightSeat({ ...provider, effortLevels: ['high'] }, { ...seat, effort: 'low' }, missingCatalogue)).rejects.toThrow('does not support effort')
  await expect(preflightSeat({ ...provider, effortLevels: [] }, { ...seat, model: undefined }, missingCatalogue)).resolves.toBeUndefined()
})

it('does not interpret a local cache or a failed live catalogue as an authoritative refusal', async () => {
  const fileProvider = { ...provider, modelDiscovery: { kind: 'file' as const, path: '/cache/models.json', parse: 'json' as const } }
  await expect(preflightSeat(fileProvider, { ...seat, model: 'new-model', effort: undefined }, deps)).resolves.toBeUndefined()
  const failedLive = { ...deps, models: async () => ({ models: ['model-a'], source: 'live' as const, refreshedAt: 0, detail: 'catalogue incomplete' }) }
  await expect(preflightSeat(provider, { ...seat, model: 'new-model', effort: undefined }, failedLive)).resolves.toBeUndefined()
  await expect(preflightSeat(provider, seat, { ...deps, auth: async () => ({ id: provider.id, state: 'logged-out', checkedAt: 0 }) })).rejects.toThrow('Provider login required')
})
