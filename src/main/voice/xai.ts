/**
 * xAI STT (REST) and Grok Speech-to-Speech (WebSocket). All network is
 * injected so tests never touch the wire. Audio goes as JSON
 * `input_audio_buffer.append` (base64 PCM16) because that frame is easy
 * to assert without a binary transport.
 */
import { VOICE_TOOLS, type VoiceFunctionTool } from './commands'
import { base64ToPcm16, encodeWavPcm16, PCM_SAMPLE_RATE, pcm16ToBase64 } from './pcm'

export const XAI_STT_URL = 'https://api.x.ai/v1/stt'
export const XAI_REALTIME_URL = 'wss://api.x.ai/v1/realtime?model=grok-voice-latest'

export function resolveXaiApiKey(stored?: string): string | undefined {
  const fromStore = stored?.trim()
  if (fromStore) return fromStore
  const fromEnv = process.env.XAI_API_KEY?.trim()
  return fromEnv || undefined
}

export interface XaiSttRequest {
  pcm: Int16Array
  language?: string
  keyterms?: string[]
  sampleRate?: number
}

export interface XaiFunctionCall {
  callId: string
  name: string
  arguments: Record<string, unknown>
}

export interface XaiRealtimeHandlers {
  onAudioOut?: (pcm: Int16Array) => void
  onFunctionCall?: (call: XaiFunctionCall) => void | Promise<void>
  onTranscript?: (delta: string) => void
  onText?: (text: string) => void
  onSessionUpdated?: () => void
  onResponseDone?: () => void
  onIdleTimeout?: () => void
  onError?: (message: string, authFailed?: boolean) => void
  onClose?: () => void
}

export interface XaiRealtimeSessionConfig {
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

export interface XaiClientDeps {
  fetch: typeof fetch
  WebSocket: InjectedWebSocketConstructor
  apiKey: string
  now?: () => number
}

export interface XaiClient {
  transcribe(request: XaiSttRequest): Promise<{ text: string }>
  connectRealtime(handlers: XaiRealtimeHandlers): Promise<void>
  updateSession(config: XaiRealtimeSessionConfig): void
  appendInputAudio(pcm: Int16Array): void
  sendFunctionOutput(callId: string, json: unknown): void
  requestResponse(): void
  forceMessage(text: string): void
  sendUserText(text: string): void
  close(): void
}

export function createXaiClient(deps: XaiClientDeps): XaiClient {
  const authHeader = `Bearer ${deps.apiKey}`
  let socket: InjectedWebSocket | undefined
  let handlers: XaiRealtimeHandlers = {}
  let closing = false

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

  async function transcribe(request: XaiSttRequest): Promise<{ text: string }> {
    const sampleRate = request.sampleRate ?? PCM_SAMPLE_RATE
    const wav = encodeWavPcm16(request.pcm, sampleRate)
    const form = new FormData()
    if (request.language) form.append('language', request.language)
    for (const term of clampKeyterms(request.keyterms)) {
      form.append('keyterm', term)
    }
    const wavCopy = new Uint8Array(wav.byteLength)
    wavCopy.set(wav)
    form.append('file', new Blob([wavCopy.buffer], { type: 'audio/wav' }), 'utterance.wav')

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
    transcribe,
    async connectRealtime(nextHandlers: XaiRealtimeHandlers): Promise<void> {
      close()
      closing = false
      handlers = nextHandlers
      const ws = new deps.WebSocket(XAI_REALTIME_URL, {
        headers: { Authorization: authHeader }
      })
      socket = ws
      await waitForOpen(ws)
      listen(ws, 'message', (event) => {
        handleMessage(event.data ?? event)
      })
      listen(ws, 'error', (event) => {
        const message = wsErrorMessage(event)
        handlers.onError?.(message, isAuthFailure(message, ''))
      })
      listen(ws, 'close', (event) => {
        socket = undefined
        const reason = typeof event.reason === 'string' ? event.reason : ''
        const code = typeof event.code === 'number' ? event.code : 0
        if (isAuthFailure(reason, String(code)) || code === 4401) {
          handlers.onError?.(reason || 'unauthorized', true)
        }
        if (!closing) handlers.onClose?.()
        closing = false
      })
    },
    updateSession(config: XaiRealtimeSessionConfig): void {
      sendJson({
        type: 'session.update',
        session: {
          voice: config.voice,
          instructions: config.instructions,
          tools: config.tools ?? VOICE_TOOLS,
          turn_detection: {
            type: 'server_vad',
            idle_timeout_ms: config.idleTimeoutMs ?? 20_000
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
      })
    },
    appendInputAudio(pcm: Int16Array): void {
      if (pcm.length === 0) return
      sendJson({
        type: 'input_audio_buffer.append',
        audio: pcm16ToBase64(pcm)
      })
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

export class XaiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly authFailed = false
  ) {
    super(message)
    this.name = 'XaiError'
  }
}

function clampKeyterms(terms: string[] | undefined): string[] {
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

function waitForOpen(ws: InjectedWebSocket): Promise<void> {
  if (ws.readyState === 1) return Promise.resolve()
  return new Promise((resolve, reject) => {
    let settled = false
    const onOpen = (): void => {
      if (settled) return
      settled = true
      resolve()
    }
    const onError = (event: unknown): void => {
      if (settled) return
      settled = true
      reject(new XaiError(wsErrorMessage(event), undefined, isAuthFailure(wsErrorMessage(event), '')))
    }
    listen(ws, 'open', onOpen)
    listen(ws, 'error', onError)
  })
}
