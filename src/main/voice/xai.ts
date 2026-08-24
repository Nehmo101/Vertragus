/**
 * xAI STT (REST) and Grok Speech-to-Speech (WebSocket). All network is
 * injected so tests never touch the wire. Audio goes as JSON
 * `input_audio_buffer.append` (base64 PCM16) because that frame is easy
 * to assert without a binary transport.
 *
 * Confirmed against current xAI docs: REST STT is `https://api.x.ai/v1/stt`;
 * realtime is `wss://api.x.ai/v1/realtime?model=grok-voice-latest` with
 * `session.update` voice + server_vad + audio.input/output PCM.
 */
import { VOICE_TOOLS } from '@shared/voice/commands'
import {
  VoiceClientError,
  clampKeyterms,
  createJsonRealtimeClient,
  resolveStoredOrEnvKey,
  wavFormFile,
  type InjectedWebSocket,
  type InjectedWebSocketConstructor,
  type JsonRealtimeClientDeps,
  type VoiceClient,
  type VoiceFunctionCall,
  type VoiceRealtimeHandlers,
  type VoiceRealtimeSessionConfig,
  type VoiceSttRequest
} from './client'
import { PCM_SAMPLE_RATE } from './pcm'

export const XAI_STT_URL = 'https://api.x.ai/v1/stt'
export const XAI_REALTIME_URL = 'wss://api.x.ai/v1/realtime?model=grok-voice-latest'
export const XAI_REALTIME_OPEN_TIMEOUT_MS = 8_000

export function resolveXaiApiKey(stored?: string): string | undefined {
  return resolveStoredOrEnvKey(stored, 'XAI_API_KEY')
}

export type XaiSttRequest = VoiceSttRequest
export type XaiFunctionCall = VoiceFunctionCall
export type XaiRealtimeHandlers = VoiceRealtimeHandlers
export type XaiRealtimeSessionConfig = VoiceRealtimeSessionConfig
export type { InjectedWebSocket, InjectedWebSocketConstructor }
export type XaiClient = VoiceClient

export interface XaiClientDeps {
  fetch: typeof fetch
  WebSocket: InjectedWebSocketConstructor
  apiKey: string
  now?: () => number
  /** Override for tests. Production default is `XAI_REALTIME_OPEN_TIMEOUT_MS`. */
  openTimeoutMs?: number
}

export function buildXaiSessionUpdate(config: VoiceRealtimeSessionConfig): unknown {
  return {
    type: 'session.update',
    session: {
      voice: config.voice,
      instructions: config.instructions,
      tools: config.tools ?? VOICE_TOOLS,
      turn_detection: {
        type: 'server_vad'
      },
      audio: {
        input: {
          format: { type: 'audio/pcm', rate: PCM_SAMPLE_RATE },
          transcription: {
            ...(config.languageHint ? { language_hint: config.languageHint } : {}),
            ...(config.keyterms && config.keyterms.length > 0
              ? { keyterms: clampKeyterms(config.keyterms) }
              : {})
          }
        },
        output: {
          format: { type: 'audio/pcm', rate: PCM_SAMPLE_RATE }
        }
      }
    }
  }
}

export function createXaiClient(deps: XaiClientDeps): XaiClient {
  const authHeader = `Bearer ${deps.apiKey}`
  const realtime: Omit<JsonRealtimeClientDeps, 'transcribe' | 'buildSessionUpdate'> = {
    fetch: deps.fetch,
    WebSocket: deps.WebSocket,
    apiKey: deps.apiKey,
    realtimeUrl: XAI_REALTIME_URL,
    headers: { Authorization: authHeader },
    now: deps.now,
    openTimeoutMs: deps.openTimeoutMs ?? XAI_REALTIME_OPEN_TIMEOUT_MS
  }

  return createJsonRealtimeClient({
    ...realtime,
    buildSessionUpdate: buildXaiSessionUpdate,
    async transcribe(request: VoiceSttRequest): Promise<{ text: string }> {
      const sampleRate = request.sampleRate ?? PCM_SAMPLE_RATE
      const form = new FormData()
      if (request.language) form.append('language', request.language)
      for (const term of clampKeyterms(request.keyterms)) {
        form.append('keyterm', term)
      }
      form.append('file', wavFormFile(request.pcm, sampleRate), 'utterance.wav')

      const response = await deps.fetch(XAI_STT_URL, {
        method: 'POST',
        headers: { Authorization: authHeader },
        body: form
      })
      if (!response.ok) {
        const authFailed = response.status === 401 || response.status === 403
        throw new XaiError(`STT HTTP ${response.status}`, response.status, authFailed)
      }
      const body: unknown = await response.json()
      const text =
        body && typeof body === 'object' && typeof (body as { text?: unknown }).text === 'string'
          ? (body as { text: string }).text
          : ''
      return { text }
    }
  })
}

export class XaiError extends VoiceClientError {
  constructor(message: string, status?: number, authFailed = false) {
    super(message, status, authFailed)
    this.name = 'XaiError'
  }
}
