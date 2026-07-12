/**
 * Exchangeable transcription provider interface (main process only).
 */
import type { Buffer } from 'node:buffer'

export interface TranscriptionRequest {
  audio: Buffer
  mimeType: string
  model: string
  language: string
  endpointUrl: string
  apiKey: string
  signal?: AbortSignal
}

export interface TranscriptionProvider {
  transcribe(req: TranscriptionRequest): Promise<string>
}
