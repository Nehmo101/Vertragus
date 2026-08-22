import { describe, expect, it } from 'vitest'
import { isRequestAllowed } from './server'

describe('isRequestAllowed', () => {
  it('accepts the bind host and loopback, rejects a foreign Host (rebinding)', () => {
    expect(isRequestAllowed({ host: '100.64.10.20:9482' }, '100.64.10.20')).toBe(true)
    expect(isRequestAllowed({ host: 'localhost:9482' }, '100.64.10.20')).toBe(true)
    expect(isRequestAllowed({ host: 'evil.example:9482' }, '100.64.10.20')).toBe(false)
    expect(isRequestAllowed({ host: undefined }, '100.64.10.20')).toBe(false)
  })

  it('rejects a foreign Origin even with a valid Host', () => {
    expect(
      isRequestAllowed({ host: '100.64.10.20:9482', origin: 'https://evil.example' }, '100.64.10.20')
    ).toBe(false)
    expect(
      isRequestAllowed({ host: '100.64.10.20:9482', origin: 'http://100.64.10.20:9482' }, '100.64.10.20')
    ).toBe(true)
  })

  it('in 0.0.0.0 mode accepts bare IP hosts but still rejects DNS names (rebinding defence stays on)', () => {
    // A LAN client reaching the app by IP is fine.
    expect(isRequestAllowed({ host: '192.168.1.5:9482' }, '0.0.0.0')).toBe(true)
    expect(isRequestAllowed({ host: '[fd7a:115c::1]:9482' }, '0.0.0.0')).toBe(true)
    // A rebinding attack needs a hostname it controls — rejected even in 0.0.0.0.
    expect(isRequestAllowed({ host: 'evil.example:9482' }, '0.0.0.0')).toBe(false)
    // And a foreign Origin is still rejected.
    expect(
      isRequestAllowed({ host: '192.168.1.5:9482', origin: 'http://evil.example' }, '0.0.0.0')
    ).toBe(false)
  })
})
