import { afterEach, describe, expect, it, vi } from 'vitest'
import { OpenAITtsProvider } from '@main/voice/OpenAITtsProvider'

const SECRET = 'sk-tts-secret-abcdef123456'
const ENDPOINT = 'https://api.openai.com/v1/audio/speech'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('OpenAITtsProvider', () => {
  it('returns audio bytes and keeps the key out of the request body', async () => {
    let captured: { headers: Record<string, string>; body: string } | undefined
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        captured = { headers: init.headers as Record<string, string>, body: String(init.body) }
        return new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 })
      })
    )
    const provider = new OpenAITtsProvider()
    const audio = await provider.synthesize({
      text: 'Hallo Welt',
      model: 'gpt-4o-mini-tts',
      voice: 'alloy',
      format: 'mp3',
      endpointUrl: ENDPOINT,
      apiKey: SECRET
    })
    expect(audio.byteLength).toBe(4)
    expect(captured?.headers.Authorization).toBe(`Bearer ${SECRET}`)
    expect(captured?.body).not.toContain(SECRET)
  })

  it('rejects an empty audio response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(new Uint8Array([]), { status: 200 }))
    )
    const provider = new OpenAITtsProvider()
    await expect(
      provider.synthesize({
        text: 'x',
        model: 'gpt-4o-mini-tts',
        voice: 'alloy',
        format: 'mp3',
        endpointUrl: ENDPOINT,
        apiKey: SECRET
      })
    ).rejects.toThrow(/Leere Audioantwort/)
  })

  it('does not leak the key in error messages', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('unauthorized', { status: 401 }))
    )
    const provider = new OpenAITtsProvider()
    await provider
      .synthesize({
        text: 'x',
        model: 'm',
        voice: 'alloy',
        format: 'mp3',
        endpointUrl: ENDPOINT,
        apiKey: SECRET
      })
      .catch((e: Error) => {
        expect(e.message).not.toContain(SECRET)
        expect(e.message).toMatch(/HTTP 401/)
      })
  })
})
