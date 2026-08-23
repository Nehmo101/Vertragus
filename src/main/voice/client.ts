/**
 * Provider-agnostic realtime + STT client. Session state lives in
 * `session.ts`; xAI and OpenAI only differ in URL, auth, STT form, and the
 * `session.update` payload. Shared wire handling (audio delta, function
 * calls, session.updated) stays here so it is not copied.
 */
import type { VoiceFunctionTool } from '@shared/voice/commands'
import { base64ToPcm16, encodeWavPcm16, pcm16ToBase64 } from './pcm'

export type VoiceProvider = 'xai' | 'openai'

export const SESSION_UPDATED_TIMEOUT_MS = 2_000
export const REALTIME_OPEN_TIMEOUT_MS = 8_000

export function resolveStoredOrEnvKey(stored: string | undefined, envName: string): string | undefined {
  const fromStore = stored?.trim()
  if (fromStore) return fromStore
  const fromEnv = process.env[envName]?.trim()
  return fromEnv || undefined
}

/**
 * Empty voiceId → provider default. A stored `eve` stays `eve` on xAI.
 * Fresh switch to OpenAI with the xAI default `eve` (schema default) becomes alloy.
 */
export function defaultVoiceId(provider: VoiceProvider, stored?: string): string {
  const trimmed = stored?.trim() ?? ''
  if (provider === 'openai') {
    if (!trimmed || trimmed === 'eve') return 'alloy'
    return trimmed
  }
  return trimmed || 'eve'
}

export interface VoiceSttRequest {
  pcm: Int16Array
  language?: string
  keyterms?: string[]
  sampleRate?: number
}

export interface VoiceFunctionCall {
  callId: string
  name: string
  arguments: Record<string, unknown>
}

export interface VoiceRealtimeHandlers {
  onAudioOut?: (pcm: Int16Array) => void
  onFunctionCall?: (call: VoiceFunctionCall) => void | Promise<void>
  onTranscript?: (delta: string) => void
  onText?: (text: string) => void
  onSessionUpdated?: () => void
  onResponseDone?: () => void
  onIdleTimeout?: () => void
  onError?: (message: string, authFailed?: boolean) => void
  onClose?: () => void
}

export interface VoiceRealtimeSessionConfig {
  voice: string
  instructions: string
  tools?: VoiceFunctionTool[]
  idleTimeoutMs?: number
  languageHint?: string
  keyterms?: string[]
}

export interface InjectedWebSocket {
  send(data: string): void
  close(code?: number, reason?: string): void
  addEventListener?(
    type: 'open' | 'message' | 'error' | 'close',
    listener: (event: { data?: unknown; code?: number; reason?: string; message?: string }) => void
  ): void
  onopen?: ((event?: unknown) => void) | null
  onmessage?: ((event: { data: unknown }) => void) | null
  onerror?: ((event: unknown) => void) | null
  onclose?: ((event?: { code?: number; reason?: string }) => void) | null
  readyState?: number
}

export type InjectedWebSocketConstructor = new (
  url: string,
  options?: { headers?: Record<string, string> }
) => InjectedWebSocket

export interface VoiceClient {
  transcribe(request: VoiceSttRequest): Promise<{ text: string }>
  connectRealtime(handlers: VoiceRealtimeHandlers): Promise<void>
  updateSession(config: VoiceRealtimeSessionConfig): void
  appendInputAudio(pcm: Int16Array): void
  commitInputAudio(): void
  sendFunctionOutput(callId: string, json: unknown): void
  requestResponse(): void
  forceMessage(text: string): void
  sendUserText(text: string): void
  close(): void
}

export interface JsonRealtimeClientDeps {
  fetch: typeof fetch
  WebSocket: InjectedWebSocketConstructor
  apiKey: string
  realtimeUrl: string
  headers: Record<string, string>
  transcribe: (request: VoiceSttRequest) => Promise<{ text: string }>
  buildSessionUpdate: (config: VoiceRealtimeSessionConfig) => unknown
  now?: () => number
  openTimeoutMs?: number
}

export function createJsonRealtimeClient(deps: JsonRealtimeClientDeps): VoiceClient {
  let socket: InjectedWebSocket | undefined
  let socketGeneration = 0
  let handlers: VoiceRealtimeHandlers = {}
  let closing = false
  const openTimeoutMs = deps.openTimeoutMs ?? REALTIME_OPEN_TIMEOUT_MS

  function sendJson(payload: unknown): void {
    if (!socket) return
    socket.send(JSON.stringify(payload))
  }

  function handleMessage(raw: unknown): void {
    const event = parseWsEvent(raw)
    if (!event || typeof event !== 'object') return
    const record = event as Record<string, unknown>
    const type = typeof record.type === 'string' ? record.type : ''

    switch (type) {
      case 'session.updated':
        handlers.onSessionUpdated?.()
        return
      case 'response.output_audio.delta':
      case 'response.audio.delta': {
        const encoded = asString(record.delta) ?? asString(record.audio)
        if (!encoded) return
        handlers.onAudioOut?.(base64ToPcm16(encoded))
        return
      }
      case 'response.output_audio_transcript.delta':
      case 'response.audio_transcript.delta': {
        const delta = asString(record.delta) ?? asString(record.transcript) ?? ''
        if (delta) handlers.onTranscript?.(delta)
        return
      }
      case 'response.output_text.delta':
      case 'response.text.delta':
      case 'response.output_text': {
        const text = asString(record.delta) ?? asString(record.text) ?? ''
        if (text) {
          handlers.onText?.(text)
          handlers.onTranscript?.(text)
        }
        return
      }
      case 'response.function_call_arguments.done': {
        const name = asString(record.name) ?? ''
        const callId = asString(record.call_id) ?? asString(record.callId) ?? ''
        const args = parseArgs(record.arguments)
        void Promise.resolve(handlers.onFunctionCall?.({ callId, name, arguments: args }))
        return
      }
      case 'response.done':
        handlers.onResponseDone?.()
        return
      case 'input_audio_buffer.timeout_triggered':
        handlers.onIdleTimeout?.()
        return
      case 'error': {
        const nested = record.error
        const nestedObj = nested && typeof nested === 'object' ? (nested as Record<string, unknown>) : undefined
        const message =
          asString(record.message) ??
          asString(nestedObj?.message) ??
          'realtime error'
        const code = asString(nestedObj?.code) ?? asString(record.code) ?? ''
        handlers.onError?.(message, isAuthFailure(message, code))
        return
      }
      default:
        return
    }
  }

  function close(): void {
    if (!socket) return
    closing = true
    const current = socket
    socket = undefined
    try {
      current.close()
    } catch {
      /* already closed */
    }
  }

  return {
    transcribe: deps.transcribe,
    async connectRealtime(nextHandlers: VoiceRealtimeHandlers): Promise<void> {
      const generation = ++socketGeneration
      close()
      closing = false
      handlers = nextHandlers
      const ws = new deps.WebSocket(deps.realtimeUrl, { headers: deps.headers })
      socket = ws
      try {
        await waitForOpen(ws, openTimeoutMs)
      } catch (error) {
        if (socketGeneration === generation && socket === ws) {
          socket = undefined
          try {
            ws.close()
          } catch {
            /* already closed */
          }
        }
        throw error
      }
      if (socketGeneration !== generation || socket !== ws) return
      listen(ws, 'message', (event) => {
        if (socketGeneration !== generation || socket !== ws) return
        handleMessage(event.data ?? event)
      })
      listen(ws, 'error', (event) => {
        if (socketGeneration !== generation || socket !== ws) return
        const message = wsErrorMessage(event)
        handlers.onError?.(message, isAuthFailure(message, ''))
      })
      listen(ws, 'close', (event) => {
        if (socketGeneration !== generation) return
        if (socket === ws) socket = undefined
        const reason = typeof event.reason === 'string' ? event.reason : ''
        const code = typeof event.code === 'number' ? event.code : 0
        if (isAuthFailure(reason, String(code)) || code === 4401) {
          handlers.onError?.(reason || 'unauthorized', true)
        }
        if (!closing) handlers.onClose?.()
        closing = false
      })
    },
    updateSession(config: VoiceRealtimeSessionConfig): void {
      sendJson(deps.buildSessionUpdate(config))
    },
    appendInputAudio(pcm: Int16Array): void {
      if (pcm.length === 0) return
      sendJson({
        type: 'input_audio_buffer.append',
        audio: pcm16ToBase64(pcm)
      })
    },
    commitInputAudio(): void {
      sendJson({ type: 'input_audio_buffer.commit' })
    },
    sendFunctionOutput(callId: string, json: unknown): void {
      sendJson({
        type: 'conversation.item.create',
        item: {
          type: 'function_call_output',
          call_id: callId,
          output: typeof json === 'string' ? json : JSON.stringify(json)
        }
      })
    },
    requestResponse(): void {
      sendJson({ type: 'response.create' })
    },
    forceMessage(text: string): void {
      sendJson({
        type: 'conversation.item.create',
        item: {
          type: 'force_message',
          role: 'assistant',
          content: [{ type: 'output_text', text }]
        }
      })
    },
    sendUserText(text: string): void {
      sendJson({
        type: 'conversation.item.create',
        item: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text }]
        }
      })
    },
    close
  }
}

export class VoiceClientError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly authFailed = false
  ) {
    super(message)
    this.name = 'VoiceClientError'
  }
}

export function clampKeyterms(terms: string[] | undefined): string[] {
  if (!terms) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const term of terms) {
    const clipped = term.trim().slice(0, 50)
    if (!clipped || seen.has(clipped)) continue
    seen.add(clipped)
    out.push(clipped)
    if (out.length >= 100) break
  }
  return out
}

export function wavFormFile(pcm: Int16Array, sampleRate: number): Blob {
  const wav = encodeWavPcm16(pcm, sampleRate)
  const wavCopy = new Uint8Array(wav.byteLength)
  wavCopy.set(wav)
  return new Blob([wavCopy.buffer], { type: 'audio/wav' })
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function parseArgs(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    return raw as Record<string, unknown>
  }
  if (typeof raw === 'string') {
    const trimmed = raw.trim()
    if (!trimmed) return {}
    try {
      const parsed: unknown = JSON.parse(trimmed)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>
      }
    } catch {
      return {}
    }
  }
  return {}
}

function parseWsEvent(raw: unknown): unknown {
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw) as unknown
    } catch {
      return undefined
    }
  }
  if (raw && typeof raw === 'object' && 'type' in (raw as object)) return raw
  if (Buffer.isBuffer(raw)) {
    try {
      return JSON.parse(raw.toString('utf8')) as unknown
    } catch {
      return undefined
    }
  }
  return undefined
}

function isAuthFailure(message: string, code: string): boolean {
  const blob = `${message} ${code}`.toLowerCase()
  return (
    blob.includes('401') ||
    blob.includes('403') ||
    blob.includes('unauthor') ||
    blob.includes('invalid_api_key') ||
    blob.includes('invalid api key')
  )
}

function wsErrorMessage(event: unknown): string {
  if (!event) return 'realtime error'
  if (event instanceof Error) return event.message
  if (typeof event === 'object' && event !== null) {
    const record = event as Record<string, unknown>
    if (typeof record.message === 'string') return record.message
    if (record.error instanceof Error) return record.error.message
  }
  return 'realtime error'
}

function listen(
  ws: InjectedWebSocket,
  type: 'open' | 'message' | 'error' | 'close',
  listener: (event: { data?: unknown; code?: number; reason?: string; message?: string }) => void
): void {
  if (typeof ws.addEventListener === 'function') {
    ws.addEventListener(type, listener)
    return
  }
  if (type === 'open') ws.onopen = () => listener({})
  if (type === 'message') ws.onmessage = (event) => listener(event)
  if (type === 'error') ws.onerror = (event) => listener(event as { message?: string })
  if (type === 'close') ws.onclose = (event) => listener(event ?? {})
}

function waitForOpen(ws: InjectedWebSocket, timeoutMs: number): Promise<void> {
  if (ws.readyState === 1) return Promise.resolve()
  return new Promise((resolve, reject) => {
    let settled = false
    const timeout = setTimeout(() => {
      if (settled) return
      settled = true
      reject(new VoiceClientError(`realtime open timeout after ${timeoutMs}ms`))
    }, timeoutMs)
    const onOpen = (): void => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      resolve()
    }
    const onError = (event: unknown): void => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      reject(
        new VoiceClientError(wsErrorMessage(event), undefined, isAuthFailure(wsErrorMessage(event), ''))
      )
    }
    listen(ws, 'open', onOpen)
    listen(ws, 'error', onError)
  })
}

