/**
 * DNS-rebinding defence for the in-app HTTP listener.
 *
 * Extracted from `server.ts` so the Chromium `/browser` bridge can share the
 * Host check without importing the MCP server (that import would cycle:
 * server → browserBridge → server).
 *
 * A browser that resolved an attacker's hostname to 127.0.0.1 still sends that
 * hostname in `Host` (and its page's `Origin`). Loopback names and the
 * configured bind host are the complete allow-list — agent CLIs connect to the
 * literal URL we hand them and never send `Origin`.
 */

export function isAllowedHostHeader(hostHeader: string | undefined, bindHost: string): boolean {
  if (!hostHeader) return false
  let hostname: string
  try {
    hostname = new URL(`http://${hostHeader}`).hostname
  } catch {
    return false
  }
  return (
    hostname === '127.0.0.1' ||
    hostname === 'localhost' ||
    hostname === '[::1]' ||
    hostname === '::1' ||
    hostname === bindHost
  )
}

export function isAllowedOrigin(origin: string | undefined, bindHost: string): boolean {
  // No Origin header = not a browser context; the Host check already ran.
  if (origin === undefined) return true
  let hostname: string
  try {
    hostname = new URL(origin).hostname
  } catch {
    return false
  }
  return (
    hostname === '127.0.0.1' ||
    hostname === 'localhost' ||
    hostname === '::1' ||
    hostname === bindHost
  )
}
