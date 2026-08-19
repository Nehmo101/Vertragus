/**
 * Pairing-token minting and the pairing URL the QR encodes.
 *
 * The token is a 256-bit secret; the URL carries it in the fragment
 * (`#token=…`) so it never reaches the server as a query parameter (fragments
 * are not sent in the HTTP request) and never lands in an access log. The web
 * client reads it from `location.hash`, exchanges it for a session over
 * `POST /api/auth`, then clears the hash.
 */
import { randomBytes } from 'node:crypto'

export function mintPairingToken(): string {
  return randomBytes(32).toString('base64url')
}

/**
 * The URL a phone opens to pair: the client origin plus the token in the
 * fragment. `host` is the bind address (a Tailscale IP, a LAN IP, or a
 * hostname the user reaches the machine by).
 */
export function pairingUrl(host: string, port: number, token: string): string {
  // Bracket a bare IPv6 literal; IPv4 and hostnames pass through untouched.
  const authority = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host
  return `http://${authority}:${port}/#token=${token}`
}
