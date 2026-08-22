/**
 * Network-interface enumeration and Tailscale detection — pure logic over an
 * injected `os.networkInterfaces()` result, so it tests without a real machine.
 *
 * The remote server's default bind is the Tailscale address: the tailnet is a
 * WireGuard-encrypted private network, so binding there exposes Vertragus to
 * the user's own devices and nothing else — no TLS, no tunnel, no open
 * internet port. Tailscale hands every node a stable address in the CGNAT
 * range `100.64.0.0/10` (RFC 6598), which is how we recognise it without
 * shelling out to the `tailscale` CLI.
 */
export interface InterfaceAddress {
  address: string
  family: 'IPv4' | 'IPv6' | number
  internal: boolean
}

export type NetworkInterfaces = Record<string, InterfaceAddress[] | undefined>

export type { BindOption } from '@shared/remote/types'
import type { BindOption } from '@shared/remote/types'

/** True for an IPv4 address inside 100.64.0.0/10 — Tailscale's CGNAT range. */
export function isTailscaleAddress(address: string): boolean {
  const parts = address.split('.')
  if (parts.length !== 4) return false
  const octets = parts.map((part) => Number(part))
  if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return false
  const [first, second] = octets as [number, number, number, number]
  // 100.64.0.0 – 100.127.255.255
  return first === 100 && second >= 64 && second <= 127
}

function isIPv4(entry: InterfaceAddress): boolean {
  return entry.family === 'IPv4' || entry.family === 4
}

/** The Tailscale IPv4 address of this machine, if it is on a tailnet. */
export function detectTailscaleAddress(interfaces: NetworkInterfaces): string | undefined {
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      if (isIPv4(entry) && !entry.internal && isTailscaleAddress(entry.address)) {
        return entry.address
      }
    }
  }
  return undefined
}

/**
 * The bind options the settings picker offers, Tailscale first when present.
 * `0.0.0.0` (all interfaces) is always offered last — it is the escape hatch
 * for a user who knows what they are doing, gated behind an explicit
 * confirmation in the UI, never a default.
 */
export function bindOptions(interfaces: NetworkInterfaces): BindOption[] {
  const options: BindOption[] = []
  const tailscale = detectTailscaleAddress(interfaces)
  if (tailscale) {
    options.push({ label: `Tailscale (${tailscale})`, address: tailscale, tailscale: true })
  }
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      if (!isIPv4(entry) || entry.internal || entry.address === tailscale) continue
      if (isTailscaleAddress(entry.address)) continue
      options.push({ label: `LAN (${entry.address})`, address: entry.address, tailscale: false })
    }
  }
  options.push({ label: 'Alle Schnittstellen (0.0.0.0)', address: '0.0.0.0', tailscale: false })
  return options
}
