import { describe, expect, it } from 'vitest'
import {
  bindOptions,
  detectTailscaleAddress,
  isTailscaleAddress,
  type NetworkInterfaces
} from './interfaces'

describe('isTailscaleAddress', () => {
  it('recognises the CGNAT range and rejects everything else', () => {
    expect(isTailscaleAddress('100.64.0.1')).toBe(true)
    expect(isTailscaleAddress('100.100.50.20')).toBe(true)
    expect(isTailscaleAddress('100.127.255.255')).toBe(true)
    // Just outside the /10.
    expect(isTailscaleAddress('100.63.255.255')).toBe(false)
    expect(isTailscaleAddress('100.128.0.0')).toBe(false)
    expect(isTailscaleAddress('192.168.1.10')).toBe(false)
    expect(isTailscaleAddress('10.0.0.1')).toBe(false)
    expect(isTailscaleAddress('not.an.ip')).toBe(false)
    expect(isTailscaleAddress('100.64.0')).toBe(false)
  })
})

const interfaces: NetworkInterfaces = {
  lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
  eth0: [{ address: '192.168.1.42', family: 'IPv4', internal: false }],
  tailscale0: [{ address: '100.101.102.103', family: 'IPv4', internal: false }]
}

describe('detectTailscaleAddress', () => {
  it('finds the tailnet address among mixed interfaces', () => {
    expect(detectTailscaleAddress(interfaces)).toBe('100.101.102.103')
  })

  it('returns undefined when no interface is on a tailnet', () => {
    expect(detectTailscaleAddress({ eth0: interfaces.eth0 })).toBeUndefined()
  })

  it('ignores internal and IPv6 addresses', () => {
    expect(
      detectTailscaleAddress({
        lo: [{ address: '100.64.0.1', family: 'IPv4', internal: true }],
        eth0: [{ address: 'fd7a:115c::1', family: 'IPv6', internal: false }]
      })
    ).toBeUndefined()
  })
})

describe('bindOptions', () => {
  it('offers Tailscale first, then LAN, then 0.0.0.0 last', () => {
    const options = bindOptions(interfaces)
    expect(options[0]).toMatchObject({ address: '100.101.102.103', tailscale: true })
    expect(options.some((option) => option.address === '192.168.1.42' && !option.tailscale)).toBe(true)
    expect(options.at(-1)?.address).toBe('0.0.0.0')
    // The loopback address is never a bind option — it would defeat the point.
    expect(options.some((option) => option.address === '127.0.0.1')).toBe(false)
  })

  it('still offers LAN and 0.0.0.0 with no tailnet present', () => {
    const options = bindOptions({ eth0: interfaces.eth0 })
    expect(options.some((option) => option.tailscale)).toBe(false)
    expect(options.map((option) => option.address)).toEqual(['192.168.1.42', '0.0.0.0'])
  })
})
