/**
 * Encrypted secret storage via Electron safeStorage.
 * Tokens and transcription API keys never enter profiles, renderer IPC read payloads, or logs.
 */
import { safeStorage } from 'electron'
import { getSetting, setSetting } from '@main/config/store'

const GITHUB_TOKEN_KEY = 'secrets.github.oauth'
const TRANSCRIPTION_KEY = 'secrets.openai.transcription'

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
  const blob = getSetting<string>(GITHUB_TOKEN_KEY)
  if (!blob?.trim()) return undefined
  if (!canEncrypt()) return undefined
  try {
    return safeStorage.decryptString(Buffer.from(blob, 'base64'))
  } catch {
    return undefined
  }
}

export function writeGithubOAuthToken(token: string, meta: Omit<StoredGithubOAuth, 'obtainedAt'>): void {
  if (!canEncrypt()) {
    throw new Error('Verschlüsselung ist auf diesem System nicht verfügbar.')
  }
  const encrypted = safeStorage.encryptString(token).toString('base64')
  setSetting(GITHUB_TOKEN_KEY, encrypted)
  setSetting('secrets.github.meta', { ...meta, obtainedAt: Date.now() } satisfies StoredGithubOAuth)
}

export function readGithubOAuthMeta(): StoredGithubOAuth | undefined {
  return getSetting<StoredGithubOAuth>('secrets.github.meta')
}

export function clearGithubOAuthToken(): void {
  setSetting(GITHUB_TOKEN_KEY, undefined)
  setSetting('secrets.github.meta', undefined)
}

export function githubOAuthClientId(): string | undefined {
  const fromEnv = process.env.ORCA_GITHUB_OAUTH_CLIENT_ID?.trim()
  if (fromEnv) return fromEnv
  const fromConfig = getSetting<string>('github.oauthClientId')?.trim()
  return fromConfig || undefined
}

export function hasTranscriptionApiKey(): boolean {
  const blob = getSetting<string>(TRANSCRIPTION_KEY)
  return Boolean(blob?.trim()) && canEncrypt()
}

export function readTranscriptionApiKey(): string | undefined {
  const blob = getSetting<string>(TRANSCRIPTION_KEY)
  if (!blob?.trim()) return undefined
  if (!canEncrypt()) return undefined
  try {
    return safeStorage.decryptString(Buffer.from(blob, 'base64'))
  } catch {
    return undefined
  }
}

export function writeTranscriptionApiKey(key: string): void {
  const trimmed = key.trim()
  if (!trimmed) {
    clearTranscriptionApiKey()
    return
  }
  if (!canEncrypt()) {
    throw new Error('Verschlüsselung ist auf diesem System nicht verfügbar.')
  }
  const encrypted = safeStorage.encryptString(trimmed).toString('base64')
  setSetting(TRANSCRIPTION_KEY, encrypted)
}

export function clearTranscriptionApiKey(): void {
  setSetting(TRANSCRIPTION_KEY, undefined)
}
