import { deflateSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { inspectPng, MIN_PNG_BYTES, MIN_PNG_WIDTH } from './panel-smoke.mjs'

/** The script is plain JS; the cast pins the contract this test relies on. */
const check = inspectPng as (buffer: unknown) => string | null

/** A syntactically valid PNG of the given size, padded to `bytes` total. */
function png(width: number, height: number, bytes = 4_096): Buffer {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const ihdr = Buffer.alloc(25)
  ihdr.writeUInt32BE(13, 0)
  ihdr.write('IHDR', 4, 'ascii')
  ihdr.writeUInt32BE(width, 8)
  ihdr.writeUInt32BE(height, 12)
  const head = Buffer.concat([signature, ihdr])
  const padding = Math.max(0, bytes - head.length)
  return Buffer.concat([head, deflateSync(Buffer.alloc(padding)), Buffer.alloc(padding)])
}

describe('inspectPng', () => {
  it('accepts a plausible panel capture', () => {
    expect(check(png(280, 900))).toBeNull()
  })

  it('rejects anything that is not a PNG', () => {
    expect(check(Buffer.from('<html>this is a white screen</html>'))).toContain('PNG-Signatur')
    expect(check(Buffer.alloc(4))).toContain('kürzer')
    expect(check('not even a buffer')).toContain('kürzer')
  })

  it('rejects a PNG whose header block is not IHDR', () => {
    const broken = png(280, 900)
    broken.write('IDAT', 12, 'ascii')
    expect(check(broken)).toContain('IHDR')
  })

  /** The failure this exists for: a window that produced a 1×1 placeholder. */
  it('rejects a capture too small to be the panel', () => {
    expect(check(png(1, 1))).toContain('zu klein')
    expect(check(png(MIN_PNG_WIDTH - 1, 900))).toContain('zu klein')
    expect(check(png(MIN_PNG_WIDTH, 100))).toBeNull()
  })

  it('rejects a correctly sized but empty capture', () => {
    const problem = check(png(280, 900, MIN_PNG_BYTES - 200))
    expect(problem).toContain('leere Fläche')
  })
})
