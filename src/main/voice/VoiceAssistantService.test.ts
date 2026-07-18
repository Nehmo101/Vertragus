import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatCompletionChoice, ChatCompletionRequest } from '@main/voice/types'
import type { VoiceAssistantDeps } from '@main/voice/assistantTools'

const mockSettings = vi.hoisted(() => ({ store: {} as Record<string, unknown> }))
const secretState = vi.hoisted(() => ({ chat: 'sk-chat-secret-abcdef' as string | undefined, tts: 'sk-tts-secret-abcdef' as string | undefined }))

vi.mock('@main/config/store', () => ({
  getSetting: (key: string) => mockSettings.store[key],
  setSetting: (key: string, value: unknown) => {
    mockSettings.store[key] = value
  }
}))

vi.mock('@main/config/secrets', () => ({
  readChatApiKey: () => secretState.chat,
  readTtsApiKey: () => secretState.tts,
  hasChatApiKey: () => Boolean(secretState.chat),
  hasTtsApiKey: () => Boolean(secretState.tts),
  hasSeparateChatApiKey: () => false,
  hasSeparateTtsApiKey: () => false,
  writeChatApiKey: vi.fn(),
  clearChatApiKey: vi.fn(),
  writeTtsApiKey: vi.fn(),
  clearTtsApiKey: vi.fn()
}))

import {
  __setChatProviderForTest,
  __setTranscribeForTest,
  __setTtsProviderForTest,
  getVoiceAssistantSettings,
  runVoiceAssistantTurn
} from '@main/voice/VoiceAssistantService'

let chatHandler: (req: ChatCompletionRequest) => Promise<ChatCompletionChoice>
let capturedRequests: ChatCompletionRequest[] = []

function text(content: string): ChatCompletionChoice {
  return { content, toolCalls: [] }
}
function call(name: string, args: Record<string, unknown>, id = 'c1'): ChatCompletionChoice {
  return {
    content: null,
    toolCalls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }]
  }
}

function makeDeps(overrides: Partial<VoiceAssistantDeps> = {}): VoiceAssistantDeps {
  return {
    listProfiles: () => [{ id: 'p1', name: 'Vertragus' }],
    listSessions: () => [],
    listAgents: () => [],
    snapshotForSession: () => undefined,
    startProfileWorkspace: vi.fn(async () => ({
      ok: true,
      sessionId: 's1',
      orchestratorId: 'o1',
      agentCount: 3,
      goalSeeded: true
    })),
    seedToOrchestrator: vi.fn(async () => true),
    stopAgents: vi.fn(async () => 2),
    ...overrides
  }
}

beforeEach(() => {
  mockSettings.store = {}
  secretState.chat = 'sk-chat-secret-abcdef'
  secretState.tts = 'sk-tts-secret-abcdef'
  capturedRequests = []
  chatHandler = async () => text('OK')
  __setChatProviderForTest({
    complete: async (req) => {
      capturedRequests.push(req)
      return chatHandler(req)
    }
  })
  __setTtsProviderForTest({ synthesize: async () => Buffer.from([9, 9, 9]) })
  __setTranscribeForTest(async () => ({ ok: true, text: 'transkribiert' }))
})

afterEach(() => {
  __setTranscribeForTest(null)
})

describe('runVoiceAssistantTurn', () => {
  it('runs a tool then produces a spoken reply', async () => {
    const deps = makeDeps()
    let calls = 0
    chatHandler = async () => {
      calls += 1
      return calls === 1 ? call('start_profile_workspace', { profileName: 'Vertragus', goal: 'Ziel' }) : text('Team läuft.')
    }
    const stages: string[] = []
    const result = await runVoiceAssistantTurn(
      { text: 'Starte Vertragus', history: [] },
      (e) => stages.push(e.stage),
      deps
    )
    expect(result.ok).toBe(true)
    expect(result.transcript).toBe('Starte Vertragus')
    expect(result.replyText).toBe('Team läuft.')
    expect(deps.startProfileWorkspace).toHaveBeenCalledWith({ profileId: 'p1', goal: 'Ziel' })
    expect(result.actions.map((a) => a.tool)).toContain('start_profile_workspace')
    expect(stages).toContain('acting')
    expect(stages).toContain('done')
  })

  it('skips STT for text input', async () => {
    const transcribe = vi.fn(async () => ({ ok: true as const, text: 'x' }))
    __setTranscribeForTest(transcribe)
    await runVoiceAssistantTurn({ text: 'Hallo' }, undefined, makeDeps())
    expect(transcribe).not.toHaveBeenCalled()
  })

  it('transcribes audio when no text is given', async () => {
    const transcribe = vi.fn(async () => ({ ok: true as const, text: 'gesprochen' }))
    __setTranscribeForTest(transcribe)
    const result = await runVoiceAssistantTurn(
      { audio: { bytes: new Uint8Array([1, 2, 3]), mimeType: 'audio/webm', durationMs: 900 } },
      undefined,
      makeDeps()
    )
    expect(transcribe).toHaveBeenCalledOnce()
    expect(result.transcript).toBe('gesprochen')
  })

  it('returns an STT error without calling the chat model', async () => {
    __setTranscribeForTest(async () => ({ ok: false as const, code: 'no_api_key', message: 'kein key' }))
    const result = await runVoiceAssistantTurn(
      { audio: { bytes: new Uint8Array([1]), mimeType: 'audio/webm', durationMs: 100 } },
      undefined,
      makeDeps()
    )
    expect(result.ok).toBe(false)
    expect(result.error).toBe('kein key')
    expect(capturedRequests).toHaveLength(0)
  })

  it('fails clearly when no chat API key is configured', async () => {
    secretState.chat = undefined
    const result = await runVoiceAssistantTurn({ text: 'Hallo' }, undefined, makeDeps())
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/API-Schlüssel/)
    expect(capturedRequests).toHaveLength(0)
  })

  it('caps the tool loop at four iterations then forces a spoken reply', async () => {
    const deps = makeDeps()
    let toolRounds = 0
    chatHandler = async (req) => {
      if (req.tools) {
        toolRounds += 1
        return call('get_status', {}, `c${toolRounds}`)
      }
      return text('Zusammenfassung.')
    }
    const result = await runVoiceAssistantTurn({ text: 'Status?' }, undefined, deps)
    expect(toolRounds).toBe(4)
    expect(result.replyText).toBe('Zusammenfassung.')
    // 4 tool-calling rounds + 1 closing round without tools.
    expect(capturedRequests).toHaveLength(5)
    expect(capturedRequests[4].tools).toBeUndefined()
  })

  it('never executes stop_agents while confirmation is pending (even across tool rounds)', async () => {
    const deps = makeDeps()
    let toolRounds = 0
    chatHandler = async (req) => {
      if (req.tools) {
        toolRounds += 1
        return call('stop_agents', {}, `c${toolRounds}`)
      }
      return text('Bestätigung nötig.')
    }
    const result = await runVoiceAssistantTurn({ text: 'Stoppe alles' }, undefined, deps)
    expect(result.confirmationRequired?.tool).toBe('stop_agents')
    expect(deps.stopAgents).not.toHaveBeenCalled()
    // Finding F-voice-confirm-loop: confirmation is surfaced but the loop still
    // consumes the remaining tool-iteration budget when the model keeps calling.
    expect(toolRounds).toBeGreaterThan(0)
    expect(toolRounds).toBeLessThanOrEqual(4)
  })

  it('surfaces a confirmation instead of executing stop_agents (D9)', async () => {
    const deps = makeDeps()
    let calls = 0
    chatHandler = async () => {
      calls += 1
      return calls === 1 ? call('stop_agents', {}) : text('Soll ich wirklich alle Agenten stoppen?')
    }
    const result = await runVoiceAssistantTurn({ text: 'Stoppe alle' }, undefined, deps)
    expect(deps.stopAgents).not.toHaveBeenCalled()
    expect(result.confirmationRequired?.tool).toBe('stop_agents')
  })

  it('keeps the context system message within the character cap', async () => {
    const bigSessions = Array.from({ length: 50 }, (_, i) => ({
      id: `s${i}`,
      profileId: 'p1',
      profileName: 'Vertragus',
      sequence: i,
      name: `Session-${i}-${'x'.repeat(400)}`,
      taskSummary: 'y'.repeat(1200),
      startedAt: i,
      active: i === 0
    }))
    const deps = makeDeps({ listSessions: () => bigSessions })
    await runVoiceAssistantTurn({ text: 'Status?' }, undefined, deps)
    const contextMsg = capturedRequests[0].messages.find((m) => m.content?.includes('App-Kontext'))
    expect(contextMsg?.content?.length ?? 0).toBeLessThan(7200)
    expect(contextMsg?.content).toContain('[gekürzt]')
  })

  it('synthesizes TTS audio when enabled', async () => {
    const synth = vi.fn(async () => Buffer.from([1, 2, 3, 4]))
    __setTtsProviderForTest({ synthesize: synth })
    const result = await runVoiceAssistantTurn({ text: 'Hallo' }, undefined, makeDeps())
    expect(synth).toHaveBeenCalledOnce()
    expect(result.replyAudio?.bytes.byteLength).toBe(4)
    expect(result.replyAudio?.mimeType).toBe('audio/mpeg')
  })

  it('omits TTS audio when disabled but keeps the spoken text', async () => {
    mockSettings.store['voiceAssistant.ttsEnabled'] = false
    const synth = vi.fn(async () => Buffer.from([1]))
    __setTtsProviderForTest({ synthesize: synth })
    const result = await runVoiceAssistantTurn({ text: 'Hallo' }, undefined, makeDeps())
    expect(synth).not.toHaveBeenCalled()
    expect(result.replyAudio).toBeNull()
    expect(result.replyText).toBe('OK')
  })

  // --- Security negative cases: API keys must never leak into any output. ---

  it('redacts the API key if a provider error echoes it', async () => {
    chatHandler = async () => {
      throw new Error(`upstream failed for key sk-chat-secret-abcdef at endpoint`)
    }
    const result = await runVoiceAssistantTurn({ text: 'Hallo' }, undefined, makeDeps())
    expect(result.ok).toBe(false)
    expect(result.error).not.toContain('sk-chat-secret-abcdef')
    expect(result.error).toContain('«redigiert»')
  })

  it('redacts the API key if the model echoes it in the reply', async () => {
    chatHandler = async () => text('Dein Schlüssel ist sk-chat-secret-abcdef, merke ihn dir.')
    const result = await runVoiceAssistantTurn({ text: 'Hallo' }, undefined, makeDeps())
    expect(result.replyText).not.toContain('sk-chat-secret-abcdef')
    expect(result.replyText).toContain('«redigiert»')
  })
})

describe('getVoiceAssistantSettings', () => {
  it('exposes defaults and key availability without leaking keys', () => {
    const settings = getVoiceAssistantSettings()
    expect(settings.chatModel).toBe('gpt-4o-mini')
    expect(settings.ttsModel).toBe('gpt-4o-mini-tts')
    expect(settings.hasChatApiKey).toBe(true)
    expect(settings.usesTranscriptionKeyForChat).toBe(true)
    expect(JSON.stringify(settings)).not.toContain('sk-chat-secret-abcdef')
  })
})
