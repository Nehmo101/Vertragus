/**
 * OpenAI-compatible chat/completions endpoint with tool calls (cloud MVP).
 *
 * The API key only ever travels in the Authorization header of this request and
 * is never echoed into the returned value, thrown errors, or logs.
 */
import type {
  ChatCompletionChoice,
  ChatCompletionRequest,
  ChatProvider,
  ChatToolCall
} from '@main/voice/types'

interface RawToolCall {
  id?: string
  type?: string
  function?: { name?: string; arguments?: string }
}

interface RawChoice {
  message?: {
    content?: string | null
    tool_calls?: RawToolCall[]
  }
}

function normalizeToolCalls(raw: RawToolCall[] | undefined): ChatToolCall[] {
  if (!Array.isArray(raw)) return []
  const calls: ChatToolCall[] = []
  for (const [index, call] of raw.entries()) {
    const name = call.function?.name?.trim()
    if (!name) continue
    calls.push({
      id: call.id?.trim() || `call_${index}`,
      type: 'function',
      function: { name, arguments: call.function?.arguments ?? '{}' }
    })
  }
  return calls
}

export class OpenAIChatProvider implements ChatProvider {
  async complete(req: ChatCompletionRequest): Promise<ChatCompletionChoice> {
    const body: Record<string, unknown> = {
      model: req.model,
      messages: req.messages,
      temperature: req.temperature ?? 0.2
    }
    if (req.tools?.length) {
      body.tools = req.tools
      body.tool_choice = 'auto'
    }

    const response = await fetch(req.endpointUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${req.apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body),
      signal: req.signal
    })

    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      throw new Error(
        detail ? `HTTP ${response.status}: ${detail.slice(0, 240)}` : `HTTP ${response.status}`
      )
    }

    const json = (await response.json()) as { choices?: RawChoice[] }
    const message = json.choices?.[0]?.message
    return {
      content: message?.content ?? null,
      toolCalls: normalizeToolCalls(message?.tool_calls)
    }
  }
}
