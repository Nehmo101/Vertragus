/**
 * Frame-based RMS VAD on Int16 PCM. The session uses this only while
 * listening so wake detection stays a cheap local burst instead of an
 * always-on realtime socket.
 */
import { concatInt16, rmsNormalized } from './pcm'

export const VAD_DEFAULT_THRESHOLD = 0.015

export type VadEvent = { type: 'speech_start' } | { type: 'speech_end'; pcm: Int16Array }

export interface VadOptions {
  sampleRate?: number
  frameMs?: number
  startMs?: number
  silenceMs?: number
  /** Normalized RMS (0..1). Default {@link VAD_DEFAULT_THRESHOLD}. */
  threshold?: number
  /** Silence kept before the detected start so the first phoneme is not clipped. */
  prefixMs?: number
}

export interface Vad {
  push(pcm: Int16Array): VadEvent | undefined
}

export function createVad(options: VadOptions = {}): Vad {
  const sampleRate = options.sampleRate ?? 24_000
  const frameMs = options.frameMs ?? 20
  const startMs = options.startMs ?? 200
  const silenceMs = options.silenceMs ?? 600
  const threshold = options.threshold ?? VAD_DEFAULT_THRESHOLD
  const prefixMs = options.prefixMs ?? 100
  const frameSize = Math.max(1, Math.round((sampleRate * frameMs) / 1000))
  const prefixFrames = Math.max(0, Math.round(prefixMs / frameMs))

  let leftover = new Int16Array(0)
  const prefix: Int16Array[] = []
  let capture: Int16Array[] = []
  let speaking = false
  let speechMs = 0
  let silenceMsRun = 0
  const pending: VadEvent[] = []

  function enqueue(event: VadEvent): void {
    pending.push(event)
  }

  function resetIdle(): void {
    speaking = false
    speechMs = 0
    silenceMsRun = 0
    capture = []
  }

  function handleFrame(frame: Int16Array): void {
    const loud = rmsNormalized(frame) >= threshold
    if (!speaking) {
      if (loud) {
        speechMs += frameMs
        capture.push(frame)
        if (speechMs >= startMs) {
          speaking = true
          silenceMsRun = 0
          capture = [...prefix, ...capture]
          prefix.length = 0
          enqueue({ type: 'speech_start' })
        }
      } else {
        speechMs = 0
        capture = []
        prefix.push(frame)
        while (prefix.length > prefixFrames) prefix.shift()
      }
      return
    }

    capture.push(frame)
    if (loud) {
      silenceMsRun = 0
      return
    }
    silenceMsRun += frameMs
    if (silenceMsRun >= silenceMs) {
      enqueue({ type: 'speech_end', pcm: concatInt16(capture) })
      prefix.length = 0
      resetIdle()
    }
  }

  return {
    push(pcm: Int16Array): VadEvent | undefined {
      if (pcm.length > 0) {
        const incoming = leftover.length === 0 ? pcm : concatInt16([leftover, pcm])
        let offset = 0
        while (offset + frameSize <= incoming.length) {
          handleFrame(new Int16Array(incoming.subarray(offset, offset + frameSize)))
          offset += frameSize
        }
        leftover = new Int16Array(incoming.subarray(offset))
      }
      return pending.shift()
    }
  }
}
