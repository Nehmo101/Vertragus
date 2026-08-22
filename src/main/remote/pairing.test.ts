import { describe, expect, it } from 'vitest'
import { mintPairingToken, pairingUrl } from './pairing'

describe('mintPairingToken', () => {
  it('produces a long, URL-safe, non-repeating secret', () => {
    const a = mintPairingToken()
    const b = mintPairingToken()
    expect(a).not.toBe(b)
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/)
    // 32 bytes base64url ≈ 43 chars.
    expect(a.length).toBeGreaterThanOrEqual(42)
  })
})

describe('pairingUrl', () => {
  it('carries the token in the fragment, not the query — it never hits an access log', () => {
    const url = pairingUrl('100.101.102.103', 9482, 'tok123')
    expect(url).toBe('http://100.101.102.103:9482/#token=tok123')
    expect(new URL(url).search).toBe('')
    expect(new URL(url).hash).toBe('#token=tok123')
  })

  it('brackets a bare IPv6 host', () => {
    expect(pairingUrl('fd7a:115c::1', 9482, 't')).toBe('http://[fd7a:115c::1]:9482/#token=t')
  })
})
