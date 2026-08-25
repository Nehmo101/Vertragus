import { describe, expect, it } from 'vitest'
import {
  BROWSER_PATH,
  browserPairingUrl,
  isBrowserBridgeOrigin,
  parseBrowserPairing
} from './browserExtension'

describe('browserPairingUrl', () => {
  it('is always loopback with the /browser path and the token', () => {
    expect(browserPairingUrl(9480, 'abc')).toBe('http://127.0.0.1:9480/browser?token=abc')
    expect(BROWSER_PATH).toBe('/browser')
  })
})

describe('parseBrowserPairing', () => {
  it('accepts the pairing URL, port:token, or a bare token', () => {
    expect(parseBrowserPairing('http://127.0.0.1:5123/browser?token=aabbccddeeff0011')).toEqual({
      port: 5123,
      token: 'aabbccddeeff0011'
    })
    expect(parseBrowserPairing('5123:aabbccddeeff0011')).toEqual({
      port: 5123,
      token: 'aabbccddeeff0011'
    })
    expect(parseBrowserPairing('aabbccddeeff0011')).toEqual({ token: 'aabbccddeeff0011' })
    expect(parseBrowserPairing('')).toBeUndefined()
    expect(parseBrowserPairing('http://evil.example/browser?token=aabbccddeeff0011')).toEqual({
      token: 'aabbccddeeff0011'
    })
  })
})

describe('isBrowserBridgeOrigin', () => {
  it('allows missing Origin, loopback pages, and extension origins — nothing else', () => {
    expect(isBrowserBridgeOrigin(undefined)).toBe(true)
    expect(isBrowserBridgeOrigin('http://127.0.0.1:5123')).toBe(true)
    expect(isBrowserBridgeOrigin('chrome-extension://abcdefghijklmnop')).toBe(true)
    expect(isBrowserBridgeOrigin('moz-extension://uuid')).toBe(true)
    expect(isBrowserBridgeOrigin('https://evil.example')).toBe(false)
    expect(isBrowserBridgeOrigin('not a url')).toBe(false)
  })
})
