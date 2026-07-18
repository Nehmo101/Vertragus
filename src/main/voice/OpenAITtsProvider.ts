/**
 * OpenAI-compatible text-to-speech endpoint (cloud MVP).
 *
 * The API key only ever travels in the Authorization header and is never echoed
 * into the returned audio bytes, thrown errors, or logs.
 */
import { Buffer } from 'node:buffer'
import type { TtsProvider, TtsRequest } from '@main/voice/types'

export class OpenAITtsProvider implements TtsProvider {
  async synthesize(req: TtsRequest): Promise<Buffer> {
    const response = await fetch(req.endpointUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${req.apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: req.model,
        voice: req.voice,
        input: req.text,
        response_format: req.format
      }),
      signal: req.signal
    })

    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      throw new Error(
        detail ? `HTTP ${response.status}: ${detail.slice(0, 240)}` : `HTTP ${response.status}`
      )
    }

    const arrayBuffer = await response.arrayBuffer()
    const audio = Buffer.from(arrayBuffer)
    if (audio.byteLength === 0) throw new Error('Leere Audioantwort vom TTS-Dienst.')
    return audio
  }
}
