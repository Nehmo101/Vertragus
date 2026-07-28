import { describe, expect, it } from 'vitest'
import { DETAIL_COLLAPSE_THRESHOLD, shouldCollapseDetail } from './ErrorCard'

describe('shouldCollapseDetail', () => {
  it('keeps short human-readable messages inline', () => {
    expect(shouldCollapseDetail('Verbindung fehlgeschlagen')).toBe(false)
    expect(shouldCollapseDetail('Timeout nach 30s')).toBe(false)
  })

  it('collapses messages past the length threshold', () => {
    const long = 'x'.repeat(DETAIL_COLLAPSE_THRESHOLD + 1)
    expect(shouldCollapseDetail(long)).toBe(true)
    expect(shouldCollapseDetail('x'.repeat(DETAIL_COLLAPSE_THRESHOLD))).toBe(false)
  })

  it('collapses multi-line output such as stack traces', () => {
    expect(shouldCollapseDetail('Error\n  at doThing (file.ts:1:1)')).toBe(true)
  })

  it('collapses technical error-class prefixes and Electron IPC wrappers', () => {
    expect(shouldCollapseDetail('TypeError: x is not a function')).toBe(true)
    expect(shouldCollapseDetail('Error: ENOENT')).toBe(true)
    expect(shouldCollapseDetail("Error invoking remote method 'remote:status': failed")).toBe(true)
  })

  it('ignores surrounding whitespace', () => {
    expect(shouldCollapseDetail('  kurzer Text  ')).toBe(false)
    expect(shouldCollapseDetail('  Error: kaputt  ')).toBe(true)
  })
})
