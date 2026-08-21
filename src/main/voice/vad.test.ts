import { describe, expect, it } from 'vitest'
import { concatInt16 } from './pcm'
import { createVad, VAD_DEFAULT_THRESHOLD, type Vad, type VadEvent } from './vad'

const SAMPLE_RATE = 24_000

function sinePcm(ms: number, amplitude = 0.6, freq = 440): Int16Array {
  const n = Math.round((SAMPLE_RATE * ms) / 1000)
  const out = new Int16Array(n)
  for (let i = 0; i < n; i += 1) {
    out[i] = Math.round(amplitude * 32767 * Math.sin((2 * Math.PI * freq * i) / SAMPLE_RATE))
  }
  return out
}

function drain(vad: Vad, pcm: Int16Array): VadEvent[] {
  const events: VadEvent[] = []
  let event = vad.push(pcm)
  while (event) {
    events.push(event)
    event = vad.push(new Int16Array(0))
  }
  return events
}

describe('createVad', () => {
  it('documents a normalized RMS threshold', () => {
    expect(VAD_DEFAULT_THRESHOLD).toBe(0.015)
  })

  it('stays quiet on silence', () => {
    const vad = createVad({ sampleRate: SAMPLE_RATE })
    expect(drain(vad, new Int16Array(SAMPLE_RATE))).toEqual([])
  })

  it('emits speech_start then speech_end around a loud burst', () => {
    const vad = createVad({ sampleRate: SAMPLE_RATE, startMs: 200, silenceMs: 600 })
    const events = drain(vad, concatInt16([sinePcm(300), new Int16Array(Math.round(SAMPLE_RATE * 0.7))]))
    expect(events.map((event) => event.type)).toEqual(['speech_start', 'speech_end'])
    const end = events[1]
    expect(end?.type).toBe('speech_end')
    if (end?.type === 'speech_end') {
      expect(end.pcm.length).toBeGreaterThan(SAMPLE_RATE * 0.2)
      expect(end.pcm.length).toBeGreaterThan(0)
    }
  })

  it('does not end speech until the silence hangover elapses', () => {
    const vad = createVad({ sampleRate: SAMPLE_RATE, startMs: 200, silenceMs: 600 })
    const started = drain(vad, sinePcm(300))
    expect(started.map((event) => event.type)).toEqual(['speech_start'])
    const stillGoing = drain(vad, new Int16Array(Math.round(SAMPLE_RATE * 0.2)))
    expect(stillGoing).toEqual([])
    const ended = drain(vad, new Int16Array(Math.round(SAMPLE_RATE * 0.5)))
    expect(ended.map((event) => event.type)).toEqual(['speech_end'])
  })
})
