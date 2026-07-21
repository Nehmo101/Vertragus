import { beforeEach, describe, expect, it, vi } from 'vitest'

// Controllable in-memory config store + safeStorage so we can exercise the
// encryption-available and unavailable branches and the key-fallback ordering.
let encryptionAvailable = true
const store = new Map<string, unknown>()

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => encryptionAvailable,
    // Reversible "encryption" for tests: tag + base64 of the plaintext.
    encryptString: (value: string) => Buffer.from(`enc:${value}`, 'utf8'),
    decryptString: (buf: Buffer) => {
      const s = buf.toString('utf8')
      if (!s.startsWith('enc:')) throw new Error('bad ciphertext')
      return s.slice(4)
    }
  }
}))

vi.mock('@main/config/store', () => ({
  getSetting: (key: string) => store.get(key),
  setSetting: (key: string, value: unknown) => {
    if (value === undefined) store.delete(key)
    else store.set(key, value)
  }
}))

vi.mock('@main/env', () => ({ brandEnv: () => undefined }))

import {
  isEncryptionAvailable,
  readGithubOAuthToken,
  writeGithubOAuthToken,
  clearGithubOAuthToken,
  readTranscriptionApiKey,
  writeTranscriptionApiKey,
  hasTranscriptionApiKey,
  readChatApiKey,
  readTtsApiKey,
  writeChatApiKey,
  writeTtsApiKey,
  hasChatApiKey,
  hasSeparateChatApiKey
} from './secrets'

beforeEach(() => {
  encryptionAvailable = true
  store.clear()
})

describe('secrets — encrypted storage', () => {
  it('round-trips the GitHub OAuth token and stores metadata', () => {
    writeGithubOAuthToken('gho_secret', { account: 'octocat', scopes: ['repo'] })
    expect(readGithubOAuthToken()).toBe('gho_secret')
    // The stored blob is never the plaintext.
    expect(store.get('secrets.github.oauth')).not.toContain('gho_secret')
    clearGithubOAuthToken()
    expect(readGithubOAuthToken()).toBeUndefined()
    expect(store.get('secrets.github.meta')).toBeUndefined()
  })

  it('round-trips the transcription key and clears on empty write', () => {
    writeTranscriptionApiKey('sk-abc')
    expect(readTranscriptionApiKey()).toBe('sk-abc')
    expect(hasTranscriptionApiKey()).toBe(true)
    writeTranscriptionApiKey('   ')
    expect(readTranscriptionApiKey()).toBeUndefined()
    expect(hasTranscriptionApiKey()).toBe(false)
  })

  it('treats missing encryption as "no key available" for reads and throws on writes', () => {
    writeTranscriptionApiKey('sk-abc')
    encryptionAvailable = false
    expect(isEncryptionAvailable()).toBe(false)
    expect(readTranscriptionApiKey()).toBeUndefined()
    expect(hasTranscriptionApiKey()).toBe(false)
    expect(() => writeTranscriptionApiKey('sk-new')).toThrow(/Verschlüsselung/)
    expect(() => writeGithubOAuthToken('x', { scopes: [] })).toThrow(/Verschlüsselung/)
  })

  it('returns undefined when the stored ciphertext cannot be decrypted', () => {
    store.set('secrets.openai.transcription', 'not-base64-enc')
    expect(readTranscriptionApiKey()).toBeUndefined()
  })

  it('falls back to the shared transcription key for chat/TTS when no dedicated key exists', () => {
    writeTranscriptionApiKey('sk-shared')
    expect(hasSeparateChatApiKey()).toBe(false)
    expect(hasChatApiKey()).toBe(true)
    expect(readChatApiKey()).toBe('sk-shared')
    expect(readTtsApiKey()).toBe('sk-shared')
  })

  it('prefers a dedicated chat/TTS key over the shared transcription key', () => {
    writeTranscriptionApiKey('sk-shared')
    writeChatApiKey('sk-chat')
    writeTtsApiKey('sk-tts')
    expect(hasSeparateChatApiKey()).toBe(true)
    expect(readChatApiKey()).toBe('sk-chat')
    expect(readTtsApiKey()).toBe('sk-tts')
  })
})
