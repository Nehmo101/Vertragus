/**
 * Inbox speech-to-text orchestration in the main process.
 */
import { Buffer } from 'node:buffer'
import { getSetting, setSetting } from '@main/config/store'
import {
  hasTranscriptionApiKey,
  isEncryptionAvailable,
  readTranscriptionApiKey,
  writeTranscriptionApiKey,
  clearTranscriptionApiKey
} from '@main/config/secrets'
import { OpenAITranscriptionProvider } from '@main/voice/OpenAITranscriptionProvider'
import type { TranscriptionProvider } from '@main/voice/types'
import {
  DEFAULT_TRANSCRIPTION_ENDPOINT,
  DEFAULT_TRANSCRIPTION_LANGUAGE,
  DEFAULT_TRANSCRIPTION_MODEL,
  INBOX_SPEECH_MAX_BYTES,
  INBOX_SPEECH_MAX_DURATION_MS,
  INBOX_SPEECH_MIN_BYTES,
  transcriptionErrorMessage,
  validateTranscriptionInput,
  type InboxSpeechSettings,
  type InboxSpeechSettingsPatch,
  type InboxSpeechStatus,
  type TranscribeAudioPayload,
  type TranscribeAudioResult
} from '@shared/inboxSpeech'
import {
  safeTranscriptionEndpointUrl,
  validateTranscriptionEndpointUrl
} from '@shared/inboxSpeechEndpoint'

const SETTINGS_MODEL = 'inboxSpeech.model'
const SETTINGS_LANGUAGE = 'inboxSpeech.language'
const SETTINGS_ENDPOINT = 'inboxSpeech.endpointUrl'

let activeProvider: TranscriptionProvider = new OpenAITranscriptionProvider()
let abortController: AbortController | null = null

/** Test hook: inject a mock provider. */
export function __setTranscriptionProviderForTest(provider: TranscriptionProvider): void {
  activeProvider = provider
}

export function getInboxSpeechStatus(): InboxSpeechStatus {
  return {
    configured: hasTranscriptionApiKey(),
    encryptionAvailable: isEncryptionAvailable(),
    model: getSetting<string>(SETTINGS_MODEL)?.trim() || DEFAULT_TRANSCRIPTION_MODEL,
    language: getSetting<string>(SETTINGS_LANGUAGE)?.trim() || DEFAULT_TRANSCRIPTION_LANGUAGE,
    endpointUrl: safeTranscriptionEndpointUrl(getSetting<string>(SETTINGS_ENDPOINT)),
    maxBytes: INBOX_SPEECH_MAX_BYTES,
    maxDurationMs: INBOX_SPEECH_MAX_DURATION_MS,
    minBytes: INBOX_SPEECH_MIN_BYTES
  }
}

export function getInboxSpeechSettings(): InboxSpeechSettings {
  const status = getInboxSpeechStatus()
  return {
    model: status.model,
    language: status.language,
    endpointUrl: status.endpointUrl,
    hasApiKey: status.configured
  }
}

export function setInboxSpeechSettings(patch: InboxSpeechSettingsPatch): InboxSpeechSettings {
  if (patch.model !== undefined) {
    const model = patch.model.trim()
    if (!model) throw new Error('Modell darf nicht leer sein.')
    setSetting(SETTINGS_MODEL, model)
  }
  if (patch.language !== undefined) {
    const language = patch.language.trim()
    if (!language) throw new Error('Sprache darf nicht leer sein.')
    setSetting(SETTINGS_LANGUAGE, language)
  }
  if (patch.endpointUrl !== undefined) {
    const endpointUrl = validateTranscriptionEndpointUrl(patch.endpointUrl)
    setSetting(SETTINGS_ENDPOINT, endpointUrl)
  }
  if (patch.apiKey !== undefined) {
    if (!patch.apiKey.trim()) clearTranscriptionApiKey()
    else writeTranscriptionApiKey(patch.apiKey)
  }
  return getInboxSpeechSettings()
}

function toBuffer(bytes: Uint8Array | ArrayBuffer | Buffer): Buffer {
  if (Buffer.isBuffer(bytes)) return bytes
  if (bytes instanceof ArrayBuffer) return Buffer.from(bytes)
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
}

export async function transcribeInboxAudio(
  payload: TranscribeAudioPayload
): Promise<TranscribeAudioResult> {
  abortController?.abort()
  abortController = new AbortController()
  const signal = abortController.signal

  const status = getInboxSpeechStatus()
  const rawEndpoint =
    getSetting<string>(SETTINGS_ENDPOINT)?.trim() || DEFAULT_TRANSCRIPTION_ENDPOINT
  let endpointUrl: string
  try {
    endpointUrl = validateTranscriptionEndpointUrl(rawEndpoint)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, code: 'provider_error', message }
  }
  if (!status.encryptionAvailable) {
    return {
      ok: false,
      code: 'encryption_unavailable',
      message: transcriptionErrorMessage('encryption_unavailable')
    }
  }
  if (!status.configured) {
    return {
      ok: false,
      code: 'no_api_key',
      message: transcriptionErrorMessage('no_api_key')
    }
  }

  const audio = toBuffer(payload.bytes)
  const validation = validateTranscriptionInput(audio.byteLength, payload.durationMs, status)
  if (validation) {
    return { ok: false, code: validation, message: transcriptionErrorMessage(validation) }
  }

  const apiKey = readTranscriptionApiKey()
  if (!apiKey) {
    return {
      ok: false,
      code: 'no_api_key',
      message: transcriptionErrorMessage('no_api_key')
    }
  }

  try {
    const text = await activeProvider.transcribe({
      audio,
      mimeType: payload.mimeType || 'audio/webm',
      model: status.model,
      language: status.language,
      endpointUrl,
      apiKey,
      signal
    })
    return { ok: true, text }
  } catch (error) {
    if (signal.aborted) {
      return { ok: false, code: 'aborted', message: transcriptionErrorMessage('aborted') }
    }
    const message = error instanceof Error ? error.message : String(error)
    const code =
      /fetch failed|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|network/i.test(message) ? 'network' : 'provider_error'
    return {
      ok: false,
      code,
      message: code === 'network' ? transcriptionErrorMessage('network') : message
    }
  } finally {
    if (abortController?.signal === signal) abortController = null
  }
}

export function abortInboxTranscription(): void {
  abortController?.abort()
}
