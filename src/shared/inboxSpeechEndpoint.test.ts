import { describe, expect, it } from 'vitest'
import {
  isPrivateOrLocalHost,
  validateTranscriptionEndpointUrl
} from './inboxSpeechEndpoint'
import { DEFAULT_TRANSCRIPTION_ENDPOINT } from './inboxSpeech'

describe('transcription endpoint allowlist', () => {
  it('accepts the default OpenAI endpoint', () => {
    expect(validateTranscriptionEndpointUrl(DEFAULT_TRANSCRIPTION_ENDPOINT)).toBe(
      DEFAULT_TRANSCRIPTION_ENDPOINT
    )
  })

  it('rejects localhost and private IP hosts', () => {
    expect(isPrivateOrLocalHost('localhost')).toBe(true)
    expect(isPrivateOrLocalHost('127.0.0.1')).toBe(true)
    expect(isPrivateOrLocalHost('192.168.1.10')).toBe(true)
    expect(isPrivateOrLocalHost('10.0.0.5')).toBe(true)
    expect(() =>
      validateTranscriptionEndpointUrl('https://127.0.0.1/v1/audio/transcriptions')
    ).toThrow(/Lokale|private/)
    expect(() =>
      validateTranscriptionEndpointUrl('https://localhost/v1/audio/transcriptions')
    ).toThrow(/Lokale|private/)
  })

  it('rejects arbitrary external hosts and non-HTTPS', () => {
    expect(() =>
      validateTranscriptionEndpointUrl('https://evil.example/v1/audio/transcriptions')
    ).toThrow(/nicht freigegeben/)
    expect(() =>
      validateTranscriptionEndpointUrl('http://api.openai.com/v1/audio/transcriptions')
    ).toThrow(/HTTPS/)
  })

  it('rejects wrong paths on allowed host', () => {
    expect(() =>
      validateTranscriptionEndpointUrl('https://api.openai.com/v1/chat/completions')
    ).toThrow(/Pfad/)
  })
})
