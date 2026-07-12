import { describe, expect, it, vi } from 'vitest'
import {
  __setTranscriptionProviderForTest,
  getInboxSpeechStatus,
  transcribeInboxAudio
} from '@main/voice/InboxSpeechService'
import type { TranscriptionProvider } from '@main/voice/types'
import { INBOX_SPEECH_MIN_BYTES } from '@shared/inboxSpeech'

vi.mock('@main/config/secrets', () => ({
  hasTranscriptionApiKey: () => true,
  isEncryptionAvailable: () => true,
  readTranscriptionApiKey: () => 'test-key',
  writeTranscriptionApiKey: vi.fn(),
  clearTranscriptionApiKey: vi.fn()
}))

describe('InboxSpeechService', () => {
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
