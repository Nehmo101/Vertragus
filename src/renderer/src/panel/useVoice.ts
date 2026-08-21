/**
 * Panel mic capture and playback.
 *
 * The whole panel is a drag region, so this hook must only run while the
 * assistant is enabled — tracks stop on disable/unmount. Sample rate 24000
 * and ScriptProcessor 4096 match the main-process PCM contract.
 */
import { useEffect, useState } from 'react'
import type { VertragusAppApi, VoiceEventPayload, VoicePhase } from '../../../preload'

const SAMPLE_RATE = 24_000
const PROCESSOR_SIZE = 4096

export interface VoiceHud {
  phase: VoicePhase
  error?: string
}

function float32ToInt16(samples: Float32Array): Int16Array {
  const out = new Int16Array(samples.length)
  for (let i = 0; i < samples.length; i += 1) {
    const clipped = Math.max(-1, Math.min(1, samples[i]!))
    out[i] = clipped < 0 ? Math.round(clipped * 0x8000) : Math.round(clipped * 0x7fff)
  }
  return out
}

function int16ToFloat32(pcm: Int16Array): Float32Array {
  const out = new Float32Array(pcm.length)
  for (let i = 0; i < pcm.length; i += 1) {
    out[i] = pcm[i]! / 32768
  }
  return out
}

function asInt16(payload: unknown): Int16Array | undefined {
  if (payload instanceof Int16Array) return payload
  if (payload instanceof ArrayBuffer) return new Int16Array(payload)
  if (ArrayBuffer.isView(payload)) {
    const view = payload as ArrayBufferView
    return new Int16Array(view.buffer, view.byteOffset, Math.floor(view.byteLength / 2))
  }
  return undefined
}

export function useVoice(bridge: VertragusAppApi | undefined, enabled: boolean): VoiceHud {
  const [hud, setHud] = useState<VoiceHud>({ phase: enabled ? 'listening' : 'idle' })

  useEffect(() => {
    if (!bridge) return
    let alive = true
    bridge.voiceStatus().then(
      (status) => {
        if (alive) setHud({ phase: status.phase, error: status.error })
      },
      () => undefined
    )
    const off = bridge.onVoice((event: VoiceEventPayload) => {
      setHud({ phase: event.phase, error: event.error })
    })
    return () => {
      alive = false
      off()
    }
  }, [bridge])

  useEffect(() => {
    if (!bridge || !enabled) {
      setHud((current) => (current.phase === 'idle' ? current : { phase: 'idle' }))
      return
    }

    let stopped = false
    let stream: MediaStream | undefined
    let ctx: AudioContext | undefined
    let processor: ScriptProcessorNode | undefined
    let source: MediaStreamAudioSourceNode | undefined
    let nextPlayAt = 0
    let offAudio: (() => void) | undefined

    const playPcm = (raw: unknown): void => {
      if (!ctx || ctx.state === 'closed') return
      const pcm = asInt16(raw)
      if (!pcm || pcm.length === 0) return
      const float = int16ToFloat32(pcm)
      const buffer = ctx.createBuffer(1, float.length, SAMPLE_RATE)
      buffer.getChannelData(0).set(float)
      const node = ctx.createBufferSource()
      node.buffer = buffer
      node.connect(ctx.destination)
      const now = ctx.currentTime
      if (nextPlayAt < now) nextPlayAt = now
      node.start(nextPlayAt)
      nextPlayAt += buffer.duration
    }

    void (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            channelCount: 1
          }
        })
        if (stopped) {
          for (const track of stream.getTracks()) track.stop()
          return
        }
        ctx = new AudioContext({ sampleRate: SAMPLE_RATE })
        source = ctx.createMediaStreamSource(stream)
        processor = ctx.createScriptProcessor(PROCESSOR_SIZE, 1, 1)
        processor.onaudioprocess = (event) => {
          if (stopped) return
          const input = event.inputBuffer.getChannelData(0)
          bridge.sendVoicePcm(float32ToInt16(input))
        }
        const mute = ctx.createGain()
        mute.gain.value = 0
        source.connect(processor)
        processor.connect(mute)
        mute.connect(ctx.destination)
        offAudio = bridge.onVoiceAudio(playPcm)
      } catch (error) {
        if (stopped) return
        const message = error instanceof Error ? error.message : String(error)
        setHud({ phase: 'error', error: message })
      }
    })()

    return () => {
      stopped = true
      offAudio?.()
      processor?.disconnect()
      source?.disconnect()
      if (stream) for (const track of stream.getTracks()) track.stop()
      void ctx?.close()
    }
  }, [bridge, enabled])

  return hud
}
