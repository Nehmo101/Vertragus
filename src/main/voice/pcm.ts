/**
 * PCM helpers shared by VAD, STT wrapping and the realtime client.
 * Int16 little-endian is the xAI native wire format; float32 is what a
 * Web Audio graph produces. WAV wrapping exists so STT can auto-detect
 * the container instead of requiring raw `audio_format` fields.
 */

export const PCM_SAMPLE_RATE = 24_000

export function float32ToInt16(samples: Float32Array): Int16Array {
  const out = new Int16Array(samples.length)
  for (let i = 0; i < samples.length; i += 1) {
    const clipped = Math.max(-1, Math.min(1, samples[i]!))
    out[i] = clipped < 0 ? Math.round(clipped * 0x8000) : Math.round(clipped * 0x7fff)
  }
  return out
}

export function int16ToFloat32(pcm: Int16Array): Float32Array {
  const out = new Float32Array(pcm.length)
  for (let i = 0; i < pcm.length; i += 1) {
    out[i] = pcm[i]! / 32768
  }
  return out
}

export function concatInt16(chunks: readonly Int16Array[]): Int16Array {
  let total = 0
  for (const chunk of chunks) total += chunk.length
  const out = new Int16Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.length
  }
  return out
}

/** RMS in 0..1 so a threshold is independent of Int16 scale. */
export function rmsNormalized(pcm: Int16Array): number {
  if (pcm.length === 0) return 0
  let sum = 0
  for (let i = 0; i < pcm.length; i += 1) {
    const x = pcm[i]! / 32768
    sum += x * x
  }
  return Math.sqrt(sum / pcm.length)
}

export function pcm16ToBase64(pcm: Int16Array): string {
  return Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).toString('base64')
}

export function base64ToPcm16(encoded: string): Int16Array {
  const bytes = Buffer.from(encoded, 'base64')
  const even = bytes.byteLength & ~1
  const copy = new Uint8Array(even)
  copy.set(bytes.subarray(0, even))
  return new Int16Array(copy.buffer, 0, even / 2)
}

export function encodeWavPcm16(pcm: Int16Array, sampleRate: number = PCM_SAMPLE_RATE): Uint8Array {
  const dataSize = pcm.byteLength
  const bytes = new Uint8Array(44 + dataSize)
  const view = new DataView(bytes.buffer)
  writeAscii(bytes, 0, 'RIFF')
  view.setUint32(4, 36 + dataSize, true)
  writeAscii(bytes, 8, 'WAVE')
  writeAscii(bytes, 12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  writeAscii(bytes, 36, 'data')
  view.setUint32(40, dataSize, true)
  bytes.set(new Uint8Array(pcm.buffer, pcm.byteOffset, dataSize), 44)
  return bytes
}

function writeAscii(bytes: Uint8Array, offset: number, text: string): void {
  for (let i = 0; i < text.length; i += 1) bytes[offset + i] = text.charCodeAt(i)
}
