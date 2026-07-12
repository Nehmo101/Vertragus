import { describe, expect, it } from 'vitest'
import {
  INBOX_SPEECH_MAX_BYTES,
  INBOX_SPEECH_MAX_DURATION_MS,
  INBOX_SPEECH_MIN_BYTES,
  transcriptionErrorMessage,
  validateTranscriptionInput
} from './inboxSpeech'

describe('inbox speech validation', () => {
  it('rejects empty and oversized recordings', () => {
    expect(validateTranscriptionInput(0, 1000)).toBe('empty_recording')
    expect(validateTranscriptionInput(INBOX_SPEECH_MIN_BYTES - 1, 1000)).toBe('empty_recording')
    expect(validateTranscriptionInput(INBOX_SPEECH_MIN_BYTES, 1000)).toBeNull()
    expect(validateTranscriptionInput(INBOX_SPEECH_MAX_BYTES + 1, 1000)).toBe('too_large')
  })

  it('rejects recordings longer than the limit', () => {
    expect(validateTranscriptionInput(5000, INBOX_SPEECH_MAX_DURATION_MS + 1)).toBe('too_long')
    expect(validateTranscriptionInput(5000, INBOX_SPEECH_MAX_DURATION_MS)).toBeNull()
  })

  it('maps error codes to German messages', () => {
    expect(transcriptionErrorMessage('no_api_key')).toContain('API-Schlüssel')
    expect(transcriptionErrorMessage('empty_recording')).toContain('leer')
    expect(transcriptionErrorMessage('network')).toContain('Netzwerk')
  })
})
