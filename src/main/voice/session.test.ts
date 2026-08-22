import { describe, expect, it, vi } from 'vitest'
import type { VoiceHost, VoiceHostWorkspace } from '@shared/voice/commands'
import { concatInt16 } from './pcm'
import { createVoiceSession, type VoicePhase } from './session'
import type {
  XaiClient,
  XaiRealtimeHandlers,
  XaiRealtimeSessionConfig,
  XaiSttRequest
} from './xai'

const SAMPLE_RATE = 24_000

function sinePcm(ms: number, amplitude = 0.6): Int16Array {
  const n = Math.round((SAMPLE_RATE * ms) / 1000)
  const out = new Int16Array(n)
  for (let i = 0; i < n; i += 1) {
    out[i] = Math.round(amplitude * 32767 * Math.sin((2 * Math.PI * 440 * i) / SAMPLE_RATE))
  }
  return out
}

function utterance(): Int16Array {
  return concatInt16([sinePcm(300), new Int16Array(Math.round(SAMPLE_RATE * 0.7))])
}

function workspace(partial: Partial<VoiceHostWorkspace> & Pick<VoiceHostWorkspace, 'workspaceId' | 'name' | 'profileId'>): VoiceHostWorkspace {
  return { active: true, agents: [], ...partial }
}

function createHost(overrides: Partial<VoiceHost> = {}): VoiceHost & { started: { profileId: string; goal?: string }[] } {
  const started: { profileId: string; goal?: string }[] = []
  return {
    started,
    listProfiles: () => [{ id: 'p-uwe', name: 'UWE' }],
    listWorkspaces: () => [
      workspace({
        workspaceId: 'ws-1',
        name: 'Paradiso',
        profileId: 'p-uwe',
        profileName: 'UWE',
        active: true
      })
    ],
    startWorkspace: async (profileId, goal) => {
      started.push({ profileId, goal })
    },
    stopWorkspace: async () => undefined,
    focusWorkspace: vi.fn(),
    focusAgent: vi.fn(),
    hideAll: vi.fn(),
    openSettings: vi.fn(),
    openProfileEditor: vi.fn(),
    setYolo: vi.fn(),
    sendToOrchestrator: async () => undefined,
    quitApp: vi.fn(),
    ...overrides
  }
}

function createFakeClient(opts?: { transcript?: string; transcribe?: XaiClient['transcribe'] }): {
  client: XaiClient
  handlers: () => XaiRealtimeHandlers | undefined
  userTexts: string[]
  forced: string[]
  outputs: { callId: string; json: unknown }[]
  responses: number
  closed: number
  sessionUpdates: XaiRealtimeSessionConfig[]
  stt: XaiSttRequest[]
  audioIn: Int16Array[]
} {
  let handlers: XaiRealtimeHandlers | undefined
  const userTexts: string[] = []
  const forced: string[] = []
  const outputs: { callId: string; json: unknown }[] = []
  let responses = 0
  let closed = 0
  const sessionUpdates: XaiRealtimeSessionConfig[] = []
  const stt: XaiSttRequest[] = []
  const audioIn: Int16Array[] = []

  const client: XaiClient = {
    transcribe: opts?.transcribe ?? (async (request) => {
      stt.push(request)
      return { text: opts?.transcript ?? 'Hey Vertragus starte den UWE workspace mit Ziel xyz' }
    }),
    connectRealtime: async (next) => {
      handlers = next
    },
    updateSession: (config) => {
      sessionUpdates.push(config)
    },
    appendInputAudio: (pcm) => {
      audioIn.push(pcm)
    },
    sendFunctionOutput: (callId, json) => {
      outputs.push({ callId, json })
    },
    requestResponse: () => {
      responses += 1
    },
    forceMessage: (text) => {
      forced.push(text)
    },
    sendUserText: (text) => {
      userTexts.push(text)
    },
    close: () => {
      closed += 1
    }
  }

  return {
    client,
    handlers: () => handlers,
    userTexts,
    forced,
    outputs,
    get responses() {
      return responses
    },
    get closed() {
      return closed
    },
    sessionUpdates,
    stt,
    audioIn
  }
}

describe('createVoiceSession', () => {
  it('starts in idle, then listening, and does not open realtime until a wake hit', async () => {
    const fake = createFakeClient({ transcript: 'nur das Wetter' })
    const phases: VoicePhase[] = []
    const session = createVoiceSession({
      host: createHost(),
      client: fake.client,
      config: { wakePhrase: 'Vertragus', voiceId: 'eve', locale: 'de' },
      onPhase: (phase) => phases.push(phase)
    })
    expect(session.phase).toBe('idle')
    session.start()
    expect(session.phase).toBe('listening')
    await session.pushPcm(utterance())
    expect(session.phase).toBe('listening')
    expect(fake.sessionUpdates).toHaveLength(0)
    expect(fake.userTexts).toHaveLength(0)
    expect(phases).toEqual(['listening'])
  })

  it('on wake + remainder connects realtime, sends the command, executes the tool, and stays engaged', async () => {
    const fake = createFakeClient()
    const host = createHost()
    const transcripts: { text: string; origin: 'user' | 'assistant' }[] = []
    const session = createVoiceSession({
      host,
      client: fake.client,
      config: { wakePhrase: 'Vertragus', voiceId: 'eve', locale: 'de', idleTimeoutMs: 20_000 },
      onTranscript: (text, origin) => transcripts.push({ text, origin })
    })
    session.start()
    await session.pushPcm(utterance())

    expect(session.phase).toBe('engaged')
    expect(fake.stt[0]?.language).toBe('de')
    expect(fake.stt[0]?.keyterms).toEqual(expect.arrayContaining(['Vertragus', 'UWE']))
    expect(fake.sessionUpdates[0]?.tools?.some((tool) => tool.name === 'start_workspace')).toBe(true)
    expect(fake.sessionUpdates[0]?.idleTimeoutMs).toBeUndefined()
    expect(fake.userTexts[0]?.toLowerCase()).toContain('starte')
    expect(fake.responses).toBe(1)
    expect(transcripts.some((row) => row.origin === 'user' && /vertragus/i.test(row.text))).toBe(true)

    await fake.handlers()?.onFunctionCall?.({
      callId: 'call_1',
      name: 'start_workspace',
      arguments: { profile: 'UWE', goal: 'xyz' }
    })
    expect(host.started).toEqual([{ profileId: 'p-uwe', goal: 'xyz' }])
    expect(fake.outputs[0]?.callId).toBe('call_1')
    expect(fake.outputs[0]?.json).toMatchObject({ ok: true })
    expect(fake.responses).toBe(2)
    expect(session.phase).toBe('engaged')
  })

  it('acks with Ja? when the remainder is empty', async () => {
    const fake = createFakeClient({ transcript: 'Hey Vertragus.' })
    const session = createVoiceSession({
      host: createHost(),
      client: fake.client,
      config: { wakePhrase: 'Vertragus', voiceId: 'eve', locale: 'de' }
    })
    session.start()
    await session.pushPcm(utterance())
    expect(fake.forced).toEqual(['Ja?'])
    expect(fake.userTexts).toHaveLength(0)
  })

  it('forwards PCM to realtime only while engaged', async () => {
    const fake = createFakeClient({ transcript: 'Hey Vertragus.' })
    const session = createVoiceSession({
      host: createHost(),
      client: fake.client,
      config: { wakePhrase: 'Vertragus', voiceId: 'eve', locale: 'de' }
    })
    const chunk = new Int16Array([3, 4])
    await session.pushPcm(chunk)
    expect(fake.audioIn).toHaveLength(0)
    session.start()
    await session.pushPcm(utterance())
    await session.pushPcm(chunk)
    expect(fake.audioIn.some((pcm) => pcm === chunk || pcm.length === 2)).toBe(true)
  })

  it('stays engaged on the tool-turn response.done after end_session and drops on the follow-up', async () => {
    const fake = createFakeClient({ transcript: 'Hey Vertragus.' })
    const session = createVoiceSession({
      host: createHost(),
      client: fake.client,
      config: { wakePhrase: 'Vertragus', voiceId: 'eve', locale: 'de' }
    })
    session.start()
    await session.pushPcm(utterance())
    await fake.handlers()?.onFunctionCall?.({
      callId: 'c-end',
      name: 'end_session',
      arguments: {}
    })
    expect(session.phase).toBe('engaged')
    fake.handlers()?.onResponseDone?.()
    expect(session.phase).toBe('engaged')
    fake.handlers()?.onResponseDone?.()
    expect(session.phase).toBe('listening')
  })

  it('does not hang up on xAI idle timeout and uses a local timer after response.done', async () => {
    const pending = new Map<number, { fn: () => void; ms: number }>()
    let nextId = 1
    const fake = createFakeClient({ transcript: 'Hey Vertragus.' })
    const session = createVoiceSession({
      host: createHost(),
      client: fake.client,
      config: { wakePhrase: 'Vertragus', voiceId: 'eve', locale: 'de', idleTimeoutMs: 20_000 },
      setTimeout: (fn, ms) => {
        const id = nextId++
        pending.set(id, { fn, ms })
        return id
      },
      clearTimeout: (id) => {
        pending.delete(id as number)
      }
    })
    session.start()
    await session.pushPcm(utterance())
    expect(fake.sessionUpdates[0]?.idleTimeoutMs).toBeUndefined()
    expect(fake.handlers()?.onIdleTimeout).toBeUndefined()
    expect(session.phase).toBe('engaged')

    fake.handlers()?.onResponseDone?.()
    expect(session.phase).toBe('engaged')
    expect([...pending.values()].map((item) => item.ms)).toEqual([20_000])

    await session.pushPcm(new Int16Array([1, 2, 3]))
    expect(pending.size).toBe(0)

    fake.handlers()?.onResponseDone?.()
    expect(pending.size).toBe(1)
    await fake.handlers()?.onFunctionCall?.({
      callId: 'c-status',
      name: 'status',
      arguments: {}
    })
    expect(pending.size).toBe(0)

    fake.handlers()?.onResponseDone?.()
    expect(pending.size).toBe(1)
    const due = [...pending.values()]
    pending.clear()
    for (const item of due) item.fn()
    expect(session.phase).toBe('listening')
  })

  it('goes to error on STT auth failure', async () => {
    const fake = createFakeClient({
      transcribe: async () => {
        throw Object.assign(new Error('STT HTTP 401'), { authFailed: true, name: 'XaiError' })
      }
    })
    const errors: string[] = []
    const session = createVoiceSession({
      host: createHost(),
      client: fake.client,
      config: { wakePhrase: 'Vertragus', voiceId: 'eve', locale: 'de' },
      onError: (message) => errors.push(message)
    })
    session.start()
    await session.pushPcm(utterance())
    expect(session.phase).toBe('error')
    expect(errors[0]).toMatch(/401/)
  })

  it('stop closes realtime and returns to idle', async () => {
    const fake = createFakeClient({ transcript: 'Hey Vertragus.' })
    const session = createVoiceSession({
      host: createHost(),
      client: fake.client,
      config: { wakePhrase: 'Vertragus', voiceId: 'eve', locale: 'de' }
    })
    session.start()
    await session.pushPcm(utterance())
    session.stop()
    expect(session.phase).toBe('idle')
    expect(fake.closed).toBeGreaterThan(0)
  })
})
