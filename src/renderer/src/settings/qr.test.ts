import { describe, expect, it } from 'vitest'
import { pairingQrSvg } from './qr'

describe('pairingQrSvg', () => {
  it('produces a self-contained SVG that encodes the URL', () => {
    const svg = pairingQrSvg('http://100.64.10.20:9482/#token=abc')
    expect(svg.startsWith('<svg')).toBe(true)
    expect(svg).toContain('viewBox')
    expect(svg).toContain('<path')
    // No external fetches — the CSP forbids them and the QR must be inline.
    // (The SVG xmlns is a namespace URI, not a network reference.)
    expect(svg).not.toContain('<image')
    expect(svg).not.toContain('href')
    expect(svg).not.toContain('url(')
  })

  it('grows the module count for a longer payload', () => {
    const short = pairingQrSvg('a')
    const long = pairingQrSvg('x'.repeat(200))
    const viewBox = (svg: string): number => Number(/viewBox="0 0 (\d+)/.exec(svg)?.[1] ?? 0)
    expect(viewBox(long)).toBeGreaterThan(viewBox(short))
  })
})
