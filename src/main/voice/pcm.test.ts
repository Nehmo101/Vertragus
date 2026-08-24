import { describe, expect, it } from 'vitest'
import {
  asInt16Pcm,
  base64ToPcm16,
  concatInt16,
  encodeWavPcm16,
  float32ToInt16,
  int16ToFloat32,
  pcm16ToBase64,
  rmsNormalized
} from './pcm'

describe('pcm', () => {
  it('round-trips float32 through int16 near full scale', () => {
    const input = new Float32Array([0, 0.5, -0.5, 1, -1])
    const pcm = float32ToInt16(input)
    expect(pcm[0]).toBe(0)
    expect(pcm[3]).toBe(32767)
    expect(pcm[4]).toBe(-32768)
    const back = int16ToFloat32(pcm)
    expect(back[1]).toBeCloseTo(0.5, 2)
    expect(back[2]).toBeCloseTo(-0.5, 2)
  })

  it('concatenates int16 chunks in order', () => {
    const joined = concatInt16([new Int16Array([1, 2]), new Int16Array([3])])
    expect([...joined]).toEqual([1, 2, 3])
  })

  it('reports zero RMS for silence and high RMS for a loud burst', () => {
    expect(rmsNormalized(new Int16Array(480))).toBe(0)
    const loud = new Int16Array(480).fill(20_000)
    expect(rmsNormalized(loud)).toBeGreaterThan(0.5)
  })

  it('round-trips PCM16 through base64', () => {
    const pcm = new Int16Array([-32768, -1, 0, 1, 32767])
    expect([...base64ToPcm16(pcm16ToBase64(pcm))]).toEqual([...pcm])
  })

  it('wraps PCM16 as a mono little-endian WAV', () => {
    const pcm = new Int16Array([1, 2, 3, 4])
    const wav = encodeWavPcm16(pcm, 24_000)
    const ascii = (start: number, len: number) =>
      String.fromCharCode(...wav.subarray(start, start + len))
    expect(ascii(0, 4)).toBe('RIFF')
    expect(ascii(8, 4)).toBe('WAVE')
    expect(ascii(12, 4)).toBe('fmt ')
    expect(ascii(36, 4)).toBe('data')
    const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength)
    expect(view.getUint32(4, true)).toBe(36 + 8)
    expect(view.getUint16(20, true)).toBe(1)
    expect(view.getUint16(22, true)).toBe(1)
    expect(view.getUint32(24, true)).toBe(24_000)
    expect(view.getUint16(34, true)).toBe(16)
    expect(view.getUint32(40, true)).toBe(8)
    expect(view.getInt16(44, true)).toBe(1)
    expect(view.getInt16(50, true)).toBe(4)
  })

  it('coerces Int16Array, Buffer, ArrayBuffer, views and number[] into PCM16', () => {
    expect([...(asInt16Pcm(new Int16Array([1, 2, 3])) ?? [])]).toEqual([1, 2, 3])
    expect([...(asInt16Pcm(Buffer.from(new Int16Array([4, 5]).buffer)) ?? [])]).toEqual([4, 5])
    expect([...(asInt16Pcm(new Int16Array([6, 7]).buffer) ?? [])]).toEqual([6, 7])
    expect([...(asInt16Pcm(new Uint8Array(new Int16Array([8, 9]).buffer)) ?? [])]).toEqual([8, 9])
    expect([...(asInt16Pcm([10, -11, 12]) ?? [])]).toEqual([10, -11, 12])
    expect(asInt16Pcm(undefined)).toBeUndefined()
    expect(asInt16Pcm({ not: 'audio' })).toBeUndefined()
  })
})
