/**
 * Inbox speech-to-text — shared limits, UI states, and IPC payloads.
 * API keys never appear in these types (main-process safeStorage only).
 */

/** Default from docs/VOICE_INTERFACE_PLAN.md */
export const DEFAULT_TRANSCRIPTION_MODEL = 'gpt-4o-transcribe'
export const DEFAULT_TRANSCRIPTION_LANGUAGE = 'de'
export const DEFAULT_TRANSCRIPTION_ENDPOINT = 'https://api.openai.com/v1/audio/transcriptions'

export const INBOX_SPEECH_MAX_BYTES = 10 * 1024 * 1024
export const INBOX_SPEECH_MAX_DURATION_MS = 120_000
export const INBOX_SPEECH_MIN_BYTES = 128

export const INBOX_SPEECH_UI_STATES = [
  'idle',
  'recording',
  'transcribing',
  'review',
  'failed'
] as const
export type InboxSpeechUiState = (typeof INBOX_SPEECH_UI_STATES)[number]

export type TranscriptionErrorCode =
  | 'no_api_key'
  | 'encryption_unavailable'
  | 'empty_recording'
  | 'too_large'
  | 'too_long'
  | 'network'
  | 'provider_error'
  | 'aborted'

export interface InboxSpeechSettings {
  model: string
  language: string
  endpointUrl: string
  /** True when a key is stored; never exposes the key itself. */
  hasApiKey: boolean
}

export interface InboxSpeechSettingsPatch {
  model?: string
  language?: string
  endpointUrl?: string
  /** Write-only; empty string clears the stored key. */
  apiKey?: string
}

export interface InboxSpeechStatus {
  configured: boolean
  encryptionAvailable: boolean
  model: string
  language: string
  endpointUrl: string
  maxBytes: number
  maxDurationMs: number
  minBytes: number
}

export interface TranscribeAudioPayload {
  mimeType: string
  /** Raw audio bytes from MediaRecorder (transferred via IPC Buffer). */
  bytes: Uint8Array | ArrayBuffer
  durationMs: number
}

export type TranscribeAudioResult =
  | { ok: true; text: string }
  | { ok: false; code: TranscriptionErrorCode; message: string }

export function validateTranscriptionInput(
  byteLength: number,
  durationMs: number,
  limits: Pick<InboxSpeechStatus, 'maxBytes' | 'maxDurationMs' | 'minBytes'> = {
    maxBytes: INBOX_SPEECH_MAX_BYTES,
    maxDurationMs: INBOX_SPEECH_MAX_DURATION_MS,
    minBytes: INBOX_SPEECH_MIN_BYTES
  }
): TranscriptionErrorCode | null {
  if (byteLength < limits.minBytes) return 'empty_recording'
  if (byteLength > limits.maxBytes) return 'too_large'
  if (durationMs > limits.maxDurationMs) return 'too_long'
  return null
}

export function transcriptionErrorMessage(code: TranscriptionErrorCode): string {
  switch (code) {
    case 'no_api_key':
      return 'Kein API-Schlüssel hinterlegt. Bitte in den Einstellungen speichern.'
    case 'encryption_unavailable':
      return 'Verschlüsselung ist auf diesem System nicht verfügbar.'
    case 'empty_recording':
      return 'Aufnahme ist leer oder zu kurz.'
    case 'too_large':
      return `Aufnahme überschreitet ${Math.round(INBOX_SPEECH_MAX_BYTES / (1024 * 1024))} MB.`
    case 'too_long':
      return `Aufnahme überschreitet ${INBOX_SPEECH_MAX_DURATION_MS / 1000} Sekunden.`
    case 'network':
      return 'Netzwerkfehler bei der Transkription.'
    case 'provider_error':
      return 'Transkriptionsdienst hat einen Fehler gemeldet.'
    case 'aborted':
      return 'Transkription abgebrochen.'
    default:
      return 'Transkription fehlgeschlagen.'
  }
}

export function microphoneErrorMessage(error: unknown): string {
  if (error instanceof DOMException) {
    if (error.name === 'NotAllowedError' || error.name === 'PermissionDeniedError') {
      return 'Mikrofonzugriff verweigert. Bitte Berechtigung in den Systemeinstellungen erlauben.'
    }
    if (error.name === 'NotFoundError' || error.name === 'DevicesNotFoundError') {
      return 'Kein Mikrofon gefunden.'
    }
    if (error.name === 'NotReadableError') {
      return 'Mikrofon wird bereits von einer anderen Anwendung verwendet.'
    }
  }
  return error instanceof Error ? error.message : 'Mikrofon konnte nicht gestartet werden.'
}
