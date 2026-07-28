import { describe, expect, it, vi, beforeEach } from 'vitest'

/**
 * Behavioral contract of the manifest-driven registration pipeline: the
 * central authorization stage ('not-voice' / 'main-window' / 'voice-window')
 * and the central zod parse (validation 'schema') run BEFORE the handler and
 * behave exactly like the previous per-handler wiring. Complements the
 * source-level ipcSurface guard, which pins WHICH channel declares which level.
 */
vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn(), on: vi.fn() }
}))

import { ipcMain } from 'electron'
import {
  createManifestChannelHandler,
  registerManifestChannels,
  type ManifestAuthDeps,
  type ManifestHandlers,
  type RegisterableManifestKey
} from './registerManifest'
import { listIpcChannels } from '@shared/ipcManifest'

const registerable = listIpcChannels().filter(
  (e) => e.spec.kind === 'invoke' || e.spec.kind === 'send'
)

interface DepsOptions {
  voiceSender?: boolean
  mainSender?: boolean
}

function makeDeps(opts: DepsOptions = {}): ManifestAuthDeps & {
  calls: string[]
} {
  const calls: string[] = []
  return {
    calls,
    assertNotVoiceWindow: vi.fn(() => {
      calls.push('assertNotVoiceWindow')
      if (opts.voiceSender) throw new Error('Voice-Fenster verboten.')
    }),
    requireMainWindow: vi.fn(() => {
      calls.push('requireMainWindow')
      if (!opts.mainSender) throw new Error('Nur Hauptfenster.')
    }),
    isVoiceWindowSender: vi.fn(() => {
      calls.push('isVoiceWindowSender')
      return Boolean(opts.voiceSender)
    })
  }
}

const fakeEvent = { sender: {} } as unknown as Electron.IpcMainInvokeEvent

function wrap(
  key: RegisterableManifestKey,
  handler: ReturnType<typeof vi.fn>,
  deps: ManifestAuthDeps
): (...args: unknown[]) => unknown {
  const wrapped = createManifestChannelHandler(
    key,
    handler as unknown as Parameters<typeof createManifestChannelHandler>[1],
    deps
  )
  return (...args: unknown[]) => wrapped(fakeEvent, ...args)
}

describe('central authorization', () => {
  it("auth 'not-voice' (invoke) throws for the voice overlay before the handler runs", () => {
    const handler = vi.fn()
    expect(() => wrap('agentKill', handler, makeDeps({ voiceSender: true }))('id')).toThrow(
      'Voice-Fenster verboten.'
    )
    expect(handler).not.toHaveBeenCalled()
  })

  it("auth 'not-voice' (invoke) lets other windows through with event + args intact", () => {
    const handler = vi.fn(() => 'ok')
    const result = wrap('agentKill', handler, makeDeps())('agent-1')
    expect(result).toBe('ok')
    expect(handler).toHaveBeenCalledWith(fakeEvent, 'agent-1')
  })

  it("auth 'not-voice' (send) silently drops the voice overlay (hot path, no reply)", () => {
    const handler = vi.fn()
    expect(wrap('agentWrite', handler, makeDeps({ voiceSender: true }))('id', 'data')).toBeUndefined()
    expect(handler).not.toHaveBeenCalled()
  })

  it("auth 'not-voice' (send) forwards non-voice senders", () => {
    const handler = vi.fn()
    wrap('agentWrite', handler, makeDeps())('id', 'data')
    expect(handler).toHaveBeenCalledWith(fakeEvent, 'id', 'data')
  })

  it("auth 'main-window' rejects non-main senders before the handler runs", () => {
    const handler = vi.fn()
    expect(() => wrap('remoteStatus', handler, makeDeps({ mainSender: false }))()).toThrow(
      'Nur Hauptfenster.'
    )
    expect(handler).not.toHaveBeenCalled()
    const okHandler = vi.fn(() => 'status')
    expect(wrap('remoteStatus', okHandler, makeDeps({ mainSender: true }))()).toBe('status')
  })

  it("auth 'voice-window' (send) drops every sender that is not the overlay", () => {
    const handler = vi.fn()
    wrap('voiceOverlayMoved', handler, makeDeps({ voiceSender: false }))(10, 20)
    expect(handler).not.toHaveBeenCalled()
    wrap('voiceOverlayMoved', handler, makeDeps({ voiceSender: true }))(10, 20)
    expect(handler).toHaveBeenCalledWith(fakeEvent, 10, 20)
  })

  it("auth 'any' / 'controller' / 'custom' apply no central gate (the handler is responsible)", () => {
    for (const key of ['appInfo', 'profileSave', 'voiceAssistantTurn'] as const) {
      const deps = makeDeps({ voiceSender: true })
      const handler = vi.fn(() => 'through')
      expect(wrap(key, handler, deps)('payload')).toBe('through')
      expect(deps.assertNotVoiceWindow).not.toHaveBeenCalled()
      expect(deps.requireMainWindow).not.toHaveBeenCalled()
    }
  })
})

describe('central schema validation', () => {
  it('parses the payload through the bound zod schema and rejects invalid shapes', () => {
    const handler = vi.fn()
    expect(() => wrap('githubListIssues', handler, makeDeps())({ owner: '' })).toThrow(
      /Ungültige Issue-Anfrage/
    )
    expect(handler).not.toHaveBeenCalled()
  })

  it('replaces the raw argument with the parsed (stripped) payload', () => {
    const handler = vi.fn()
    wrap('githubListIssues', handler, makeDeps())({ owner: 'a', repo: 'b', evil: 'x' })
    expect(handler).toHaveBeenCalledWith(fakeEvent, { owner: 'a', repo: 'b' })
  })

  it('runs the auth gate BEFORE the schema parse (mcpSave order)', () => {
    const handler = vi.fn()
    const deps = makeDeps({ voiceSender: true })
    // invalid payload — but the voice guard must fire first
    expect(() => wrap('mcpSave', handler, deps)(42)).toThrow('Voice-Fenster verboten.')
    expect(handler).not.toHaveBeenCalled()
  })

  it('schemaOptional lets undefined through untouched (ideasCreate)', () => {
    const handler = vi.fn()
    wrap('ideasCreate', handler, makeDeps())(undefined)
    expect(handler).toHaveBeenCalledWith(fakeEvent, undefined)
    expect(() => wrap('ideasCreate', handler, makeDeps())(42)).toThrow(/Ungültige Ideen-Eingabe/)
  })

  it('schemaArg parses the declared argument and leaves the others raw (ideasAddArtifact)', () => {
    const handler = vi.fn()
    wrap('ideasAddArtifact', handler, makeDeps())('idea-1', {
      kind: 'text',
      text: 'hello',
      evil: 'x'
    })
    expect(handler).toHaveBeenCalledWith(fakeEvent, 'idea-1', { kind: 'text', text: 'hello' })
    expect(() => wrap('ideasAddArtifact', handler, makeDeps())('idea-1', { kind: 'nope' })).toThrow(
      /Ungültige Artefakt-Eingabe/
    )
  })
})

describe('registerManifestChannels', () => {
  beforeEach(() => {
    vi.mocked(ipcMain.handle).mockClear()
    vi.mocked(ipcMain.on).mockClear()
  })

  it('registers every manifest invoke channel via ipcMain.handle and every send via ipcMain.on', () => {
    const handlers = Object.fromEntries(
      registerable.map((e) => [e.key, vi.fn()])
    ) as unknown as ManifestHandlers
    registerManifestChannels(handlers, makeDeps())
    const handled = vi.mocked(ipcMain.handle).mock.calls.map((c) => c[0])
    const on = vi.mocked(ipcMain.on).mock.calls.map((c) => c[0])
    expect(handled.sort()).toEqual(
      registerable.filter((e) => e.spec.kind === 'invoke').map((e) => e.spec.channel).sort()
    )
    expect(on.sort()).toEqual(
      registerable.filter((e) => e.spec.kind === 'send').map((e) => e.spec.channel).sort()
    )
    // no duplicates
    expect(new Set([...handled, ...on]).size).toBe(handled.length + on.length)
  })
})
