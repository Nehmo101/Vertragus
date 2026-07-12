/**
 * OpenAI-compatible audio transcriptions endpoint (cloud MVP).
 */
import type { TranscriptionProvider, TranscriptionRequest } from '@main/voice/types'

function extensionForMime(mimeType: string): string {
  if (mimeType.includes('webm')) return 'webm'
  if (mimeType.includes('ogg')) return 'ogg'
  if (mimeType.includes('mp4') || mimeType.includes('m4a')) return 'm4a'
  if (mimeType.includes('mpeg') || mimeType.includes('mp3')) return 'mp3'
  if (mimeType.includes('wav')) return 'wav'
  return 'webm'
}

export class OpenAITranscriptionProvider implements TranscriptionProvider {
  async transcribe(req: TranscriptionRequest): Promise<string> {
    const ext = extensionForMime(req.mimeType)
    const bytes = Uint8Array.from(req.audio)
    const blob = new Blob([bytes], { type: req.mimeType })
    const form = new FormData()
    form.append('file', blob, `inbox-recording.${ext}`)
    form.append('model', req.model)
    form.append('language', req.language)
    form.append('response_format', 'json')

    const response = await fetch(req.endpointUrl, {
      method: 'POST',
      headers: { Authorization: `Bearer ${req.apiKey}` },
      body: form,
      signal: req.signal
    })

    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      throw new Error(
        detail ? `HTTP ${response.status}: ${detail.slice(0, 240)}` : `HTTP ${response.status}`
      )
    }

    const json = (await response.json()) as { text?: string }
    const text = json.text?.trim() ?? ''
    if (!text) throw new Error('Leere Transkription vom Dienst.')
    return text
  }
}
