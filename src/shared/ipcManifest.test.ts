import { describe, expect, it, vi } from 'vitest'
import {
  buildVertragusApi,
  ipcManifest,
  listIpcChannels,
  type CustomBridgeBindings,
  type IpcTransport
} from './ipcManifest'
import { IPC } from './ipc'

/**
 * Behavioral contract of the generic preload builder. The channel-per-entry
 * correctness of the WHOLE surface is walked in src/main/ipc/ipcSurface.test.ts;
 * this file pins the builder mechanics: argument pass-through, subscription
 * lifecycle (unsubscribe), custom-binding enforcement and manifest sanity.
 */

function makeTransport(): IpcTransport & {
  invokes: unknown[][]
  sends: unknown[][]
  listeners: Map<string, (payload: unknown) => void>
  unsubscribed: string[]
} {
  const invokes: unknown[][] = []
  const sends: unknown[][] = []
  const listeners = new Map<string, (payload: unknown) => void>()
  const unsubscribed: string[] = []
  return {
    invokes,
    sends,
    listeners,
    unsubscribed,
    invoke: async (channel, ...args) => {
      invokes.push([channel, ...args])
      return 'invoke-result'
    },
    send: (channel, ...args) => {
      sends.push([channel, ...args])
    },
    subscribe: (channel, cb) => {
      listeners.set(channel, cb)
      return () => {
        unsubscribed.push(channel)
      }
    }
  }
}

const customStub = Object.fromEntries(
  listIpcChannels()
    .filter((e) => e.spec.bridge === 'custom')
    .map((e) => [e.key, vi.fn(() => 'custom')])
) as unknown as CustomBridgeBindings

describe('buildVertragusApi', () => {
  it('passes invoke arguments through and returns the transport result', async () => {
    const transport = makeTransport()
    const api = buildVertragusApi(transport, customStub)
    await expect(api.gitInfo('C:/repo')).resolves.toBe('invoke-result')
    expect(transport.invokes).toEqual([[IPC.gitInfo, 'C:/repo']])
  })

  it('passes one-way send arguments through', () => {
    const transport = makeTransport()
    const api = buildVertragusApi(transport, customStub)
    api.agents.write('agent-1', 'ls\n')
    api.win.minimize()
    expect(transport.sends).toEqual([[IPC.agentWrite, 'agent-1', 'ls\n'], [IPC.winMinimize]])
  })

  it('wires event subscriptions with a working unsubscribe', () => {
    const transport = makeTransport()
    const api = buildVertragusApi(transport, customStub)
    const seen: unknown[] = []
    const unsubscribe = api.updates.onState((state) => seen.push(state))
    transport.listeners.get(IPC.evAppUpdateState)!({ status: 'idle' })
    expect(seen).toEqual([{ status: 'idle' }])
    unsubscribe()
    expect(transport.unsubscribed).toEqual([IPC.evAppUpdateState])
  })

  it('exposes the voiceAssistant.onProgress alias on the same push channel', () => {
    const transport = makeTransport()
    const api = buildVertragusApi(transport, customStub)
    api.events.onVoiceAssistant(() => {})
    expect(transport.listeners.has(IPC.evVoiceAssistant)).toBe(true)
    transport.listeners.delete(IPC.evVoiceAssistant)
    api.voiceAssistant.onProgress(() => {})
    expect(transport.listeners.has(IPC.evVoiceAssistant)).toBe(true)
  })

  it('uses the hand-written custom bindings instead of a generic bridge', () => {
    const transport = makeTransport()
    const api = buildVertragusApi(transport, customStub)
    expect(api.files.pathForFile({} as File)).toBe('custom')
    expect(transport.invokes).toEqual([])
  })

  it('throws when a bridge:custom entry has no binding', () => {
    expect(() =>
      buildVertragusApi(makeTransport(), {} as CustomBridgeBindings)
    ).toThrow(/missing custom preload binding/)
  })
})

describe('manifest sanity', () => {
  it('api paths are unique (two entries on one path would shadow each other)', () => {
    const paths = listIpcChannels().map((e) => e.spec.api)
    const dupes = paths.filter((p, i) => paths.indexOf(p) !== i)
    expect(dupes).toEqual([])
  })

  it('schema options only appear on schema-validated entries', () => {
    for (const { key, spec } of listIpcChannels()) {
      if (spec.validation !== 'schema') {
        expect(spec.schemaArg, `${key} sets schemaArg without validation 'schema'`).toBeUndefined()
        expect(
          spec.schemaOptional,
          `${key} sets schemaOptional without validation 'schema'`
        ).toBeUndefined()
      }
    }
  })

  it('every registerable entry declares auth and validation', () => {
    for (const { key, spec } of listIpcChannels()) {
      if (spec.kind === 'invoke' || spec.kind === 'send') {
        expect(spec.auth, `${key} lacks an auth level`).toBeTruthy()
        expect(spec.validation, `${key} lacks a validation mode`).toBeTruthy()
      }
    }
  })

  it('exports a stable manifest object (spot check)', () => {
    expect(ipcManifest.agentSpawn.channel).toBe(IPC.agentSpawn)
    expect(ipcManifest.agentSpawn.kind).toBe('invoke')
    expect(ipcManifest.agentSpawn.auth).toBe('not-voice')
    expect(ipcManifest.agentSpawn.validation).toBe('schema')
  })
})
