import { afterEach, describe, expect, it, vi } from 'vitest'
import { pcm16ToBase64 } from './pcm'
import {
  createXaiClient,
  resolveXaiApiKey,
  XAI_REALTIME_URL,
  XAI_STT_URL,
  type InjectedWebSocket,
  type InjectedWebSocketConstructor,
  type XaiFunctionCall
} from './xai'

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

/** Socket that never emits `open`, used to exercise waitForOpen's timeout. */
class HangWebSocket implements InjectedWebSocket {
  static instances: HangWebSocket[] = []
  readonly sent: string[] = []
  readonly listeners = new Map<string, Array<(event: { data?: unknown; code?: number; reason?: string }) => void>>()
  readyState = 0

  constructor(
    readonly url: string,
    readonly options?: { headers?: Record<string, string> }
  ) {
    HangWebSocket.instances.push(this)
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
}

afterEach(() => {
  FakeWebSocket.instances = []
  HangWebSocket.instances = []
  delete process.env.XAI_API_KEY
})

describe('resolveXaiApiKey', () => {
  it('prefers a trimmed stored key over the environment', () => {
    process.env.XAI_API_KEY = 'env-key'
    expect(resolveXaiApiKey('  stored-key  ')).toBe('stored-key')
    expect(resolveXaiApiKey('   ')).toBe('env-key')
    expect(resolveXaiApiKey(undefined)).toBe('env-key')
  })

  it('returns undefined when nothing is configured', () => {
    expect(resolveXaiApiKey(undefined)).toBeUndefined()
    expect(resolveXaiApiKey('')).toBeUndefined()
  })
})

describe('createXaiClient STT', () => {
  it('POSTs a WAV to /v1/stt with bearer auth, language and keyterms', async () => {
    let url = ''
    let method = ''
    let authorization = ''
    let language: FormDataEntryValue | null = null
    const keyterms: string[] = []
    let fileName = ''
    let wavHeader = ''

    const fetchFn: typeof fetch = async (input, init) => {
      url = String(input)
      method = init?.method ?? ''
      const headers = new Headers(init?.headers)
      authorization = headers.get('Authorization') ?? ''
      const body = init?.body
      expect(body).toBeInstanceOf(FormData)
      const form = body as FormData
      language = form.get('language')
      keyterms.push(...form.getAll('keyterm').map(String))
      const file = form.get('file')
      expect(file).toBeInstanceOf(Blob)
      const blob = file as Blob
      if ('name' in blob) fileName = String((blob as File).name)
      const bytes = new Uint8Array(await blob.arrayBuffer())
      wavHeader = String.fromCharCode(...bytes.subarray(0, 4))
      return new Response(JSON.stringify({ text: 'Bei Fu0 starte' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      })
    }

    const client = createXaiClient({
      fetch: fetchFn,
      WebSocket: FakeWebSocket as unknown as InjectedWebSocketConstructor,
      apiKey: 'test-key'
    })
    const result = await client.transcribe({
      pcm: new Int16Array([1, 2, 3, 4]),
      language: 'de',
      keyterms: ['Bei Fu0', 'UWE']
    })

    expect(result).toEqual({ text: 'Bei Fu0 starte' })
    expect(url).toBe(XAI_STT_URL)
    expect(method).toBe('POST')
    expect(authorization).toBe('Bearer test-key')
    expect(language).toBe('de')
    expect(keyterms).toEqual(['Bei Fu0', 'UWE'])
    expect(wavHeader).toBe('RIFF')
    expect(fileName === '' || fileName.endsWith('.wav')).toBe(true)
  })
})

describe('createXaiClient realtime', () => {
  it('opens grok-voice-latest with bearer auth and runs a function-call roundtrip', async () => {
    const audioOut: Int16Array[] = []
    const calls: XaiFunctionCall[] = []
    const transcripts: string[] = []
    const client = createXaiClient({
      fetch: (async () => new Response('no')) as typeof fetch,
      WebSocket: FakeWebSocket as unknown as InjectedWebSocketConstructor,
      apiKey: 'rt-key'
    })

    await client.connectRealtime({
      onAudioOut: (pcm) => audioOut.push(pcm),
      onFunctionCall: (call) => {
        calls.push(call)
      },
      onTranscript: (delta) => transcripts.push(delta)
    })

    const ws = FakeWebSocket.instances[0]!
    expect(ws.url).toBe(XAI_REALTIME_URL)
    expect(ws.options?.headers?.Authorization).toBe('Bearer rt-key')

    client.updateSession({
      voice: 'eve',
      instructions: 'test',
      idleTimeoutMs: 20_000,
      languageHint: 'de',
      keyterms: ['Vertragus', 'UWE']
    })
    const update = ws.parsed()[0] as {
      type: string
      session: {
        voice: string
        tools: { name: string }[]
        turn_detection: { type: string; idle_timeout_ms?: number }
        audio: {
          input: { format: { type: string; rate: number }; transcription: { language_hint: string; keyterms: string[] } }
        }
      }
    }
    expect(update.type).toBe('session.update')
    expect(update.session.voice).toBe('eve')
    expect(update.session.turn_detection).toEqual({ type: 'server_vad' })
    expect(update.session.turn_detection).not.toHaveProperty('idle_timeout_ms')
    expect(JSON.stringify(update)).not.toContain('idle_timeout_ms')
    expect(update.session.audio.input.format).toEqual({ type: 'audio/pcm', rate: 24_000 })
    expect(update.session.audio.input.transcription.language_hint).toBe('de')
    expect(update.session.audio.input.transcription.keyterms).toContain('Vertragus')
    expect(update.session.tools.some((tool) => tool.name === 'start_workspace')).toBe(true)

    const pcm = new Int16Array([9, 8, 7])
    client.appendInputAudio(pcm)
    const append = ws.parsed()[1] as { type: string; audio: string }
    expect(append.type).toBe('input_audio_buffer.append')
    expect(append.audio).toBe(pcm16ToBase64(pcm))

    ws.emitJson({
      type: 'response.output_audio.delta',
      delta: pcm16ToBase64(new Int16Array([1, 2]))
    })
    expect([...audioOut[0]!]).toEqual([1, 2])

    ws.emitJson({ type: 'response.output_audio_transcript.delta', delta: 'Starte ' })
    expect(transcripts).toContain('Starte ')

    ws.emitJson({
      type: 'response.function_call_arguments.done',
      name: 'start_workspace',
      call_id: 'call_1',
      arguments: JSON.stringify({ profile: 'UWE', goal: 'xyz' })
    })
    expect(calls).toEqual([
      { callId: 'call_1', name: 'start_workspace', arguments: { profile: 'UWE', goal: 'xyz' } }
    ])

    client.sendFunctionOutput('call_1', { ok: true, message: 'Starte UWE.' })
    client.requestResponse()
    const frames = ws.parsed()
    expect(frames).toContainEqual({
      type: 'conversation.item.create',
      item: {
        type: 'function_call_output',
        call_id: 'call_1',
        output: JSON.stringify({ ok: true, message: 'Starte UWE.' })
      }
    })
    expect(frames).toContainEqual({ type: 'response.create' })

    client.sendUserText('starte UWE')
    client.forceMessage('Ja?')
    const later = ws.parsed()
    expect(later.at(-2)).toMatchObject({
      type: 'conversation.item.create',
      item: { type: 'message', role: 'user' }
    })
    expect(later.at(-1)).toMatchObject({
      type: 'conversation.item.create',
      item: { type: 'force_message' }
    })
  })

  it('ignores close from a superseded socket so the live socket can still send', async () => {
    const client = createXaiClient({
      fetch: (async () => new Response('no')) as typeof fetch,
      WebSocket: FakeWebSocket as unknown as InjectedWebSocketConstructor,
      apiKey: 'rt-key'
    })

    await client.connectRealtime({})
    const first = FakeWebSocket.instances[0]!
    await client.connectRealtime({})
    const second = FakeWebSocket.instances[1]!
    expect(second).not.toBe(first)

    first.emit('close', { code: 1000, reason: 'superseded' })

    const pcm = new Int16Array([1, 2, 3, 4])
    client.appendInputAudio(pcm)
    expect(second.parsed()).toContainEqual({
      type: 'input_audio_buffer.append',
      audio: pcm16ToBase64(pcm)
    })
  })

  it('rejects connectRealtime when the socket never opens', async () => {
    vi.useFakeTimers()
    try {
      const client = createXaiClient({
        fetch: (async () => new Response('no')) as typeof fetch,
        WebSocket: HangWebSocket as unknown as InjectedWebSocketConstructor,
        apiKey: 'rt-key',
        openTimeoutMs: 25
      })
      const pending = client.connectRealtime({})
      const assertion = expect(pending).rejects.toThrow(/timeout/i)
      await vi.advanceTimersByTimeAsync(25)
      await assertion
    } finally {
      vi.useRealTimers()
    }
  })
})
