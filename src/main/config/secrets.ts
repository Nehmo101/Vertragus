/**
 * Encrypted secret storage via Electron safeStorage.
 * Tokens and transcription API keys never enter profiles, renderer IPC read payloads, or logs.
 */
import { safeStorage } from 'electron'
import { getSetting, setSetting } from '@main/config/store'
import { brandEnv } from '@main/env'

const GITHUB_TOKEN_KEY = 'secrets.github.oauth'
const TRANSCRIPTION_KEY = 'secrets.openai.transcription'
const VOICE_CHAT_KEY = 'secrets.openai.voiceChat'
const VOICE_TTS_KEY = 'secrets.openai.voiceTts'

export interface StoredGithubOAuth {
  account?: string
  scopes: string[]
  obtainedAt: number
}

function canEncrypt(): boolean {
  try {
    return safeStorage.isEncryptionAvailable()
  } catch {
    return false
  }
}

export function isEncryptionAvailable(): boolean {
  return canEncrypt()
}

export function readGithubOAuthToken(): string | undefined {
  return readEncryptedString(GITHUB_TOKEN_KEY)
}

export function writeGithubOAuthToken(token: string, meta: Omit<StoredGithubOAuth, 'obtainedAt'>): void {
  if (!canEncrypt()) {
    throw new Error('Verschlüsselung ist auf diesem System nicht verfügbar.')
  }
  const encrypted = safeStorage.encryptString(token).toString('base64')
  setSetting(GITHUB_TOKEN_KEY, encrypted)
  setSetting('secrets.github.meta', { ...meta, obtainedAt: Date.now() } satisfies StoredGithubOAuth)
}

export function clearGithubOAuthToken(): void {
  setSetting(GITHUB_TOKEN_KEY, undefined)
  setSetting('secrets.github.meta', undefined)
}

export function githubOAuthClientId(): string | undefined {
  const fromEnv = brandEnv('GITHUB_OAUTH_CLIENT_ID')?.trim()
  if (fromEnv) return fromEnv
  const fromConfig = getSetting<string>('github.oauthClientId')?.trim()
  return fromConfig || undefined
}

export function hasTranscriptionApiKey(): boolean {
  const blob = getSetting<string>(TRANSCRIPTION_KEY)
  return Boolean(blob?.trim()) && canEncrypt()
}

export function readTranscriptionApiKey(): string | undefined {
  return readEncryptedString(TRANSCRIPTION_KEY)
}

export function writeTranscriptionApiKey(key: string): void {
  writeEncryptedString(TRANSCRIPTION_KEY, key)
}

export function clearTranscriptionApiKey(): void {
  setSetting(TRANSCRIPTION_KEY, undefined)
}

// ---------------------------------------------------------------------------
// Voice assistant keys (chat + TTS). By default the transcription key is reused
// for both (plan D11); an optional separate key overrides it per channel. Keys
// never leave the main process — they only enter Authorization headers.
// ---------------------------------------------------------------------------

function readEncryptedString(key: string): string | undefined {
  const blob = getSetting<string>(key)
  if (!blob?.trim()) return undefined
  if (!canEncrypt()) return undefined
  try {
    return safeStorage.decryptString(Buffer.from(blob, 'base64'))
  } catch {
    return undefined
  }
}

function writeEncryptedString(key: string, value: string): void {
  const trimmed = value.trim()
  if (!trimmed) {
    setSetting(key, undefined)
    return
  }
  if (!canEncrypt()) {
    throw new Error('Verschlüsselung ist auf diesem System nicht verfügbar.')
  }
  setSetting(key, safeStorage.encryptString(trimmed).toString('base64'))
}

/** True when a dedicated (non-shared) chat key is stored. */
export function hasSeparateChatApiKey(): boolean {
  return Boolean(getSetting<string>(VOICE_CHAT_KEY)?.trim()) && canEncrypt()
}

/** True when a dedicated (non-shared) TTS key is stored. */
export function hasSeparateTtsApiKey(): boolean {
  return Boolean(getSetting<string>(VOICE_TTS_KEY)?.trim()) && canEncrypt()
}

/** A chat key is usable when either a dedicated or the shared transcription key exists. */
export function hasChatApiKey(): boolean {
  return hasSeparateChatApiKey() || hasTranscriptionApiKey()
}

export function hasTtsApiKey(): boolean {
  return hasSeparateTtsApiKey() || hasTranscriptionApiKey()
}

export function readChatApiKey(): string | undefined {
  return readEncryptedString(VOICE_CHAT_KEY) ?? readTranscriptionApiKey()
}

export function readTtsApiKey(): string | undefined {
  return readEncryptedString(VOICE_TTS_KEY) ?? readTranscriptionApiKey()
}

export function writeChatApiKey(key: string): void {
  writeEncryptedString(VOICE_CHAT_KEY, key)
}

export function clearChatApiKey(): void {
  setSetting(VOICE_CHAT_KEY, undefined)
}

export function writeTtsApiKey(key: string): void {
  writeEncryptedString(VOICE_TTS_KEY, key)
}

export function clearTtsApiKey(): void {
  setSetting(VOICE_TTS_KEY, undefined)
}
