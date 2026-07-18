import { afterEach, describe, expect, it, vi } from 'vitest'
import { OpenAIChatProvider } from '@main/voice/OpenAIChatProvider'

const SECRET = 'sk-chat-secret-abcdef123456'
const ENDPOINT = 'https://api.openai.com/v1/chat/completions'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('OpenAIChatProvider', () => {
  it('sends the key only in the Authorization header, never in the body', async () => {
    let captured: { headers: Record<string, string>; body: string } | undefined
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        captured = {
          headers: init.headers as Record<string, string>,
          body: String(init.body)
        }
        return new Response(
          JSON.stringify({ choices: [{ message: { content: 'Hallo', tool_calls: [] } }] }),
          { status: 200 }
        )
      })
    )

    const provider = new OpenAIChatProvider()
    const result = await provider.complete({
      messages: [{ role: 'user', content: 'Hi' }],
      model: 'gpt-4o-mini',
      endpointUrl: ENDPOINT,
      apiKey: SECRET
    })

    expect(result.content).toBe('Hallo')
    expect(captured?.headers.Authorization).toBe(`Bearer ${SECRET}`)
    expect(captured?.body).not.toContain(SECRET)
  })

  it('parses tool calls from the completion', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: null,
                  tool_calls: [
                    { id: 'c1', type: 'function', function: { name: 'get_status', arguments: '{}' } }
                  ]
                }
              }
            ]
          }),
          { status: 200 }
        )
      )
    )
    const provider = new OpenAIChatProvider()
    const result = await provider.complete({
      messages: [],
      tools: [],
      model: 'gpt-4o-mini',
      endpointUrl: ENDPOINT,
      apiKey: SECRET
    })
    expect(result.toolCalls).toHaveLength(1)
    expect(result.toolCalls[0].function.name).toBe('get_status')
  })

  it('does not leak the key in error messages', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('upstream rejected request', { status: 401 }))
    )
    const provider = new OpenAIChatProvider()
    await expect(
      provider.complete({
        messages: [],
        model: 'gpt-4o-mini',
        endpointUrl: ENDPOINT,
        apiKey: SECRET
      })
    ).rejects.toThrow(/HTTP 401/)
    await expect(
      provider
        .complete({ messages: [], model: 'x', endpointUrl: ENDPOINT, apiKey: SECRET })
        .catch((e: Error) => {
          expect(e.message).not.toContain(SECRET)
          throw e
        })
    ).rejects.toThrow()
  })
})
