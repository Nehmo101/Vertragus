import { describe, expect, it, vi, beforeEach } from 'vitest'
import {
  __setTranscriptionProviderForTest,
  getInboxSpeechStatus,
  setInboxSpeechSettings,
  transcribeInboxAudio
} from '@main/voice/InboxSpeechService'
import type { TranscriptionProvider } from '@main/voice/types'
import { INBOX_SPEECH_MIN_BYTES } from '@shared/inboxSpeech'

const mockSettings: Record<string, unknown> = {}

vi.mock('@main/config/store', () => ({
  getSetting: (key: string) => mockSettings[key],
  setSetting: (key: string, value: unknown) => {
    mockSettings[key] = value
  }
}))

vi.mock('@main/config/secrets', () => ({
  hasTranscriptionApiKey: () => true,
  isEncryptionAvailable: () => true,
  readTranscriptionApiKey: () => 'test-key',
  writeTranscriptionApiKey: vi.fn(),
  clearTranscriptionApiKey: vi.fn()
}))

describe('InboxSpeechService', () => {
  beforeEach(() => {
    for (const key of Object.keys(mockSettings)) delete mockSettings[key]
  })

  it('rejects disallowed endpoint URLs when saving settings', () => {
    expect(() =>
      setInboxSpeechSettings({ endpointUrl: 'https://127.0.0.1/v1/audio/transcriptions' })
    ).toThrow(/Lokale|private/)
    expect(() =>
      setInboxSpeechSettings({ endpointUrl: 'https://evil.example/v1/audio/transcriptions' })
    ).toThrow(/freigegeben/)
  })

  it('rejects disallowed endpoint before calling provider', async () => {
    mockSettings['inboxSpeech.endpointUrl'] = 'https://127.0.0.1/v1/audio/transcriptions'
    const transcribe = vi.fn()
    __setTranscriptionProviderForTest({ transcribe } satisfies TranscriptionProvider)
    const bytes = new Uint8Array(INBOX_SPEECH_MIN_BYTES + 50).fill(1)
    const result = await transcribeInboxAudio({
      mimeType: 'audio/webm',
      bytes,
      durationMs: 1200
    })
    expect(transcribe).not.toHaveBeenCalled()
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('provider_error')
  })

  it('rejects empty audio before calling provider', async () => {
    const transcribe = vi.fn()
    __setTranscriptionProviderForTest({ transcribe } satisfies TranscriptionProvider)
    const result = await transcribeInboxAudio({
      mimeType: 'audio/webm',
      bytes: new Uint8Array(10),
      durationMs: 500
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('empty_recording')
    expect(transcribe).not.toHaveBeenCalled()
  })

  it('returns transcript text from provider', async () => {
    const transcribe = vi.fn().mockResolvedValue('Hallo Welt')
    __setTranscriptionProviderForTest({ transcribe } satisfies TranscriptionProvider)
    const bytes = new Uint8Array(INBOX_SPEECH_MIN_BYTES + 50).fill(1)
    const result = await transcribeInboxAudio({
      mimeType: 'audio/webm',
      bytes,
      durationMs: 1200
    })
    expect(result).toEqual({ ok: true, text: 'Hallo Welt' })
    expect(transcribe).toHaveBeenCalledOnce()
  })

  it('exposes limits in status', () => {
    const status = getInboxSpeechStatus()
    expect(status.maxBytes).toBeGreaterThan(0)
    expect(status.maxDurationMs).toBeGreaterThan(0)
    expect(status.minBytes).toBeGreaterThan(0)
  })
})
