/**
 * OpenAI transcriptions (REST) and Realtime (WebSocket). Same VoiceClient
 * methods as the xAI client so `session.ts` stays provider-agnostic.
 *
 * Realtime model: `gpt-realtime` (GA alias). Not `gpt-4o-realtime-preview`.
 * Socket: `wss://api.openai.com/v1/realtime?model=gpt-realtime`.
 * STT: `https://api.openai.com/v1/audio/transcriptions` with whisper-1.
 */
import { VOICE_TOOLS } from '@shared/voice/commands'
import {
  VoiceClientError,
  createJsonRealtimeClient,
  resolveStoredOrEnvKey,
  wavFormFile,
  type InjectedWebSocketConstructor,
  type VoiceClient,
  type VoiceRealtimeSessionConfig,
  type VoiceSttRequest
} from './client'
import { PCM_SAMPLE_RATE } from './pcm'

export const OPENAI_STT_URL = 'https://api.openai.com/v1/audio/transcriptions'
export const OPENAI_REALTIME_MODEL = 'gpt-realtime'
export const OPENAI_REALTIME_URL = `wss://api.openai.com/v1/realtime?model=${OPENAI_REALTIME_MODEL}`
export const OPENAI_STT_MODEL = 'whisper-1'

export function resolveOpenaiApiKey(stored?: string): string | undefined {
  return resolveStoredOrEnvKey(stored, 'OPENAI_API_KEY')
}

export interface OpenaiClientDeps {
  fetch: typeof fetch
  WebSocket: InjectedWebSocketConstructor
  apiKey: string
  now?: () => number
  openTimeoutMs?: number
}

export function buildOpenaiSessionUpdate(config: VoiceRealtimeSessionConfig): unknown {
  return {
    type: 'session.update',
    session: {
      type: 'realtime',
      model: OPENAI_REALTIME_MODEL,
      instructions: config.instructions,
      tools: config.tools ?? VOICE_TOOLS,
      audio: {
        input: {
          format: { type: 'audio/pcm', rate: PCM_SAMPLE_RATE },
          turn_detection: { type: 'server_vad' }
        },
        output: {
          format: { type: 'audio/pcm', rate: PCM_SAMPLE_RATE },
          voice: config.voice
        }
      }
    }
  }
}

export function createOpenaiClient(deps: OpenaiClientDeps): VoiceClient {
  const authHeader = `Bearer ${deps.apiKey}`
  return createJsonRealtimeClient({
    fetch: deps.fetch,
    WebSocket: deps.WebSocket,
    apiKey: deps.apiKey,
    realtimeUrl: OPENAI_REALTIME_URL,
    headers: { Authorization: authHeader },
    now: deps.now,
    openTimeoutMs: deps.openTimeoutMs,
    buildSessionUpdate: buildOpenaiSessionUpdate,
    async transcribe(request: VoiceSttRequest): Promise<{ text: string }> {
      const sampleRate = request.sampleRate ?? PCM_SAMPLE_RATE
      const form = new FormData()
      form.append('model', OPENAI_STT_MODEL)
      if (request.language) form.append('language', request.language)
      form.append('file', wavFormFile(request.pcm, sampleRate), 'utterance.wav')

      const response = await deps.fetch(OPENAI_STT_URL, {
        method: 'POST',
        headers: { Authorization: authHeader },
        body: form
      })
      if (!response.ok) {
        const authFailed = response.status === 401 || response.status === 403
        throw new OpenaiError(`STT HTTP ${response.status}`, response.status, authFailed)
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

export class OpenaiError extends VoiceClientError {
  constructor(message: string, status?: number, authFailed = false) {
    super(message, status, authFailed)
    this.name = 'OpenaiError'
  }
}
