import { afterEach, describe, expect, it } from 'vitest'
import { pcm16ToBase64 } from './pcm'
import { defaultVoiceId } from './client'
import {
  createOpenaiClient,
  OPENAI_REALTIME_URL,
  OPENAI_STT_MODEL,
  OPENAI_STT_URL,
  resolveOpenaiApiKey
} from './openai'
import type { InjectedWebSocket, InjectedWebSocketConstructor, VoiceFunctionCall } from './client'

class FakeWebSocket implements InjectedWebSocket {
  static instances: FakeWebSocket[] = []
  readonly sent: string[] = []
  readonly listeners = new Map<string, Array<(event: { data?: unknown; code?: number; reason?: string }) => void>>()
  readyState = 0

  constructor(
    readonly url: string,
    readonly options?: { headers?: Record<string, string> }
  ) {
    FakeWebSocket.instances.push(this)
    queueMicrotask(() => {
      this.readyState = 1
      this.emit('open', {})
    })
  }

  addEventListener(
    type: 'open' | 'message' | 'error' | 'close',
    listener: (event: { data?: unknown; code?: number; reason?: string }) => void
  ): void {
    const list = this.listeners.get(type) ?? []
    list.push(listener)
    this.listeners.set(type, list)
  }

  send(data: string): void {
    this.sent.push(data)
  }

  close(code = 1000, reason = ''): void {
    this.readyState = 3
    this.emit('close', { code, reason })
  }

  emit(type: string, event: { data?: unknown; code?: number; reason?: string }): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event)
  }

  emitJson(payload: unknown): void {
    this.emit('message', { data: JSON.stringify(payload) })
  }

  parsed(): unknown[] {
    return this.sent.map((frame) => JSON.parse(frame) as unknown)
  }
}

afterEach(() => {
  FakeWebSocket.instances = []
  delete process.env.OPENAI_API_KEY
})

describe('resolveOpenaiApiKey', () => {
  it('prefers a trimmed stored key over the environment', () => {
    process.env.OPENAI_API_KEY = 'env-key'
    expect(resolveOpenaiApiKey('  stored-key  ')).toBe('stored-key')
    expect(resolveOpenaiApiKey('   ')).toBe('env-key')
    expect(resolveOpenaiApiKey(undefined)).toBe('env-key')
  })
})

describe('defaultVoiceId', () => {
  it('keeps a stored eve for xAI and defaults alloy for OpenAI when empty or eve', () => {
    expect(defaultVoiceId('xai', 'eve')).toBe('eve')
    expect(defaultVoiceId('xai', '')).toBe('eve')
    expect(defaultVoiceId('openai', '')).toBe('alloy')
    expect(defaultVoiceId('openai', 'eve')).toBe('alloy')
    expect(defaultVoiceId('openai', 'verse')).toBe('verse')
  })
})

describe('createOpenaiClient STT', () => {
  it('POSTs a WAV to /v1/audio/transcriptions with bearer auth', async () => {
    let url = ''
    let authorization = ''
    let model: FormDataEntryValue | null = null
    let language: FormDataEntryValue | null = null
    let wavHeader = ''

    const fetchFn: typeof fetch = async (input, init) => {
      url = String(input)
      const headers = new Headers(init?.headers)
      authorization = headers.get('Authorization') ?? ''
      const form = init?.body as FormData
      model = form.get('model')
      language = form.get('language')
      const file = form.get('file') as Blob
      const bytes = new Uint8Array(await file.arrayBuffer())
      wavHeader = String.fromCharCode(...bytes.subarray(0, 4))
      return new Response(JSON.stringify({ text: 'Hey Vertragus' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      })
    }

    const client = createOpenaiClient({
      fetch: fetchFn,
      WebSocket: FakeWebSocket as unknown as InjectedWebSocketConstructor,
      apiKey: 'sk-test'
    })
    const result = await client.transcribe({
      pcm: new Int16Array([1, 2, 3, 4]),
      language: 'de'
    })

    expect(result).toEqual({ text: 'Hey Vertragus' })
    expect(OPENAI_STT_URL).toBe('https://api.openai.com/v1/audio/transcriptions')
    expect(url).toBe(OPENAI_STT_URL)
    expect(authorization).toBe('Bearer sk-test')
    expect(model).toBe(OPENAI_STT_MODEL)
    expect(language).toBe('de')
    expect(wavHeader).toBe('RIFF')
  })
})

describe('createOpenaiClient realtime', () => {
  it('opens gpt-realtime with bearer auth and parses audio delta', async () => {
    const audioOut: Int16Array[] = []
    const calls: VoiceFunctionCall[] = []
    const client = createOpenaiClient({
      fetch: (async () => new Response('no')) as typeof fetch,
      WebSocket: FakeWebSocket as unknown as InjectedWebSocketConstructor,
      apiKey: 'sk-rt'
    })

    await client.connectRealtime({
      onAudioOut: (pcm) => audioOut.push(pcm),
      onFunctionCall: (call) => {
        calls.push(call)
      }
    })

    const ws = FakeWebSocket.instances[0]!
    expect(OPENAI_REALTIME_URL).toBe('wss://api.openai.com/v1/realtime?model=gpt-realtime')
    expect(ws.url).toBe(OPENAI_REALTIME_URL)
    expect(ws.options?.headers?.Authorization).toBe('Bearer sk-rt')

    client.updateSession({
      voice: 'alloy',
      instructions: 'test',
      languageHint: 'de'
    })
    const update = ws.parsed()[0] as {
      type: string
      session: {
        type: string
        model: string
        audio: {
          output: { voice: string; format: { type: string; rate: number } }
          input: { turn_detection: { type: string } }
        }
        tools: { name: string }[]
      }
    }
    expect(update.type).toBe('session.update')
    expect(update.session.type).toBe('realtime')
    expect(update.session.model).toBe('gpt-realtime')
    expect(update.session.audio.output.voice).toBe('alloy')
    expect(update.session.audio.input.turn_detection).toEqual({ type: 'server_vad' })
    expect(update.session.tools.some((tool) => tool.name === 'start_workspace')).toBe(true)

    const pcm = new Int16Array([9, 8, 7])
    client.appendInputAudio(pcm)
    expect(ws.parsed()[1]).toEqual({
      type: 'input_audio_buffer.append',
      audio: pcm16ToBase64(pcm)
    })
    client.commitInputAudio()
    expect(ws.parsed()[2]).toEqual({ type: 'input_audio_buffer.commit' })

    ws.emitJson({
      type: 'response.output_audio.delta',
      delta: pcm16ToBase64(new Int16Array([1, 2]))
    })
    expect([...audioOut[0]!]).toEqual([1, 2])

    ws.emitJson({
      type: 'response.function_call_arguments.done',
      name: 'status',
      call_id: 'c1',
      arguments: '{}'
    })
    expect(calls).toEqual([{ callId: 'c1', name: 'status', arguments: {} }])
  })
})
