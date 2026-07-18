import { describe, expect, it, vi } from 'vitest'
import {
  OVERLAY_CONTROL_FORBIDDEN,
  VOICE_TURN_FORBIDDEN,
  VOICE_WINDOW_FORBIDDEN,
  adaptVoiceTurnRequest,
  adaptVoiceTurnResult,
  guardNotVoiceWindow,
  guardOverlayControl,
  guardVoiceTurnAllowed,
  resolveOrchestratorSend,
  type OrchestratorSendDeps
} from '@main/voice/voiceIpc'
import type { VoiceAssistantTurnResult } from '@main/voice/types'

describe('sender guards (authorization negatives)', () => {
  it('rejects the voice window from privileged agent/spawn channels', () => {
    // Authorization negative: the overlay must never reach a spawn channel.
    expect(() => guardNotVoiceWindow(true)).toThrow(VOICE_WINDOW_FORBIDDEN)
    expect(() => guardNotVoiceWindow(false)).not.toThrow()
  })

  it('refuses a voice turn from a window that is neither overlay nor main', () => {
    // Authorization negative: an unknown/pop-out window cannot run a turn.
    expect(() => guardVoiceTurnAllowed(false, false)).toThrow(VOICE_TURN_FORBIDDEN)
    expect(() => guardVoiceTurnAllowed(true, false)).not.toThrow()
    expect(() => guardVoiceTurnAllowed(false, true)).not.toThrow()
  })

  it('refuses overlay hide/move control from an unrelated window', () => {
    expect(() => guardOverlayControl(false, false)).toThrow(OVERLAY_CONTROL_FORBIDDEN)
    expect(() => guardOverlayControl(true, false)).not.toThrow()
    expect(() => guardOverlayControl(false, true)).not.toThrow()
  })
})

describe('adaptVoiceTurnRequest (input validation)', () => {
  it('defaults a missing request to an empty history turn', () => {
    const req = adaptVoiceTurnRequest(undefined)
    expect(req).toEqual({ text: undefined, audio: undefined, history: [] })
  })

  it('prefers text over audio and ignores audio when text is present', () => {
    const req = adaptVoiceTurnRequest({
      text: 'hallo',
      audio: new Uint8Array([1, 2, 3]),
      mimeType: 'audio/webm',
      history: []
    })
    expect(req.text).toBe('hallo')
    expect(req.audio).toBeUndefined()
  })

  it('nests audio with safe mime/duration defaults when no text is given', () => {
    const bytes = new Uint8Array([9, 9])
    const req = adaptVoiceTurnRequest({ audio: bytes, history: [] })
    expect(req.text).toBeUndefined()
    expect(req.audio).toEqual({ bytes, mimeType: 'audio/webm', durationMs: 0 })
  })

  it('drops malformed history entries (validation negative)', () => {
    const req = adaptVoiceTurnRequest({
      text: 'x',
      history: [
        { role: 'user', content: 'keep me' },
        { role: 'assistant', content: '   ' },
        // @ts-expect-error deliberately malformed entry
        { role: 'user', content: 42 },
        // @ts-expect-error deliberately malformed entry
        null
      ]
    })
    expect(req.history).toEqual([{ role: 'user', content: 'keep me' }])
  })

  it('normalizes an unknown role to user', () => {
    const req = adaptVoiceTurnRequest({
      text: 'x',
      // @ts-expect-error unknown role should fold to user
      history: [{ role: 'system', content: 'hi' }]
    })
    expect(req.history?.[0]?.role).toBe('user')
  })
})

describe('adaptVoiceTurnResult (flattening)', () => {
  const base: VoiceAssistantTurnResult = {
    ok: true,
    transcript: 't',
    replyText: 'r',
    replyAudio: null,
    actions: [],
    uiCommands: [],
    confirmationRequired: null
  }

  it('flattens reply audio bytes and null-coalesces the audio', () => {
    const bytes = new Uint8Array([1])
    expect(adaptVoiceTurnResult({ ...base, replyAudio: { bytes, mimeType: 'audio/mpeg' } }).replyAudio).toBe(bytes)
    expect(adaptVoiceTurnResult(base).replyAudio).toBeNull()
  })

  it('surfaces only tool + prompt from a confirmation and maps error to reason', () => {
    const out = adaptVoiceTurnResult({
      ...base,
      ok: false,
      error: 'boom',
      confirmationRequired: { tool: 'stop_agents', prompt: 'Wirklich stoppen?', args: { profileName: 'x' } }
    })
    expect(out.confirmationRequired).toEqual({ tool: 'stop_agents', prompt: 'Wirklich stoppen?' })
    expect(out.reason).toBe('boom')
  })
})

describe('resolveOrchestratorSend', () => {
  const baseDeps = (): OrchestratorSendDeps => ({
    hasProfile: (id) => id === 'p1',
    activeSessionId: () => 's1',
    findOrchestratorId: (sessionId) => (sessionId === 's1' ? 'orch-1' : undefined),
    seed: vi.fn(async () => true)
  })

  it('rejects empty text and missing profile id (validation negative)', async () => {
    expect(await resolveOrchestratorSend(baseDeps(), 'p1', undefined, '   ')).toEqual({ ok: false, reason: 'invalid' })
    expect(await resolveOrchestratorSend(baseDeps(), '', undefined, 'hi')).toEqual({ ok: false, reason: 'invalid' })
    expect(await resolveOrchestratorSend(baseDeps(), 'p1', undefined, 123)).toEqual({ ok: false, reason: 'invalid' })
  })

  it('reports an unknown profile', async () => {
    expect(await resolveOrchestratorSend(baseDeps(), 'ghost', undefined, 'hi')).toEqual({
      ok: false,
      reason: 'profile_not_found'
    })
  })

  it('reports no orchestrator when no active session exists', async () => {
    const deps = { ...baseDeps(), activeSessionId: () => undefined }
    expect(await resolveOrchestratorSend(deps, 'p1', undefined, 'hi')).toEqual({ ok: false, reason: 'no_orchestrator' })
  })

  it('reports no orchestrator when the session has no orchestrator agent', async () => {
    const deps = { ...baseDeps(), findOrchestratorId: () => undefined }
    expect(await resolveOrchestratorSend(deps, 'p1', 's1', 'hi')).toEqual({ ok: false, reason: 'no_orchestrator' })
  })

  it('seeds the resolved orchestrator and reports success', async () => {
    const deps = baseDeps()
    expect(await resolveOrchestratorSend(deps, 'p1', 's1', '  do it  ')).toEqual({ ok: true })
    expect(deps.seed).toHaveBeenCalledWith('orch-1', 'do it')
  })

  it('falls back to the active session when none is supplied', async () => {
    const deps = baseDeps()
    const active = vi.spyOn(deps, 'activeSessionId')
    expect(await resolveOrchestratorSend(deps, 'p1', undefined, 'hi')).toEqual({ ok: true })
    expect(active).toHaveBeenCalledWith('p1')
  })

  it('reports a seed failure distinctly', async () => {
    const deps = { ...baseDeps(), seed: vi.fn(async () => false) }
    expect(await resolveOrchestratorSend(deps, 'p1', 's1', 'hi')).toEqual({ ok: false, reason: 'seed_failed' })
  })
})
