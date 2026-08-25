/**
 * Types and pairing helpers for the Chromium extension that drives the
 * user's real browser on behalf of a Vertragus worker.
 *
 * The extension is NOT a second MCP server. It pairs with the in-app MCP
 * HTTP listener on loopback (`/browser`) and workers call `browser_*` tools
 * on their existing Vertragus identity. One host path, one token.
 */

export const BROWSER_PATH = '/browser'

/** Commands the extension understands — the worker MCP tools are a thin wrap. */
export const BROWSER_COMMANDS = [
  'tabs',
  'navigate',
  'snapshot',
  'click',
  'fill',
  'press',
  'screenshot'
] as const
export type BrowserCommand = (typeof BROWSER_COMMANDS)[number]

export interface BrowserExtensionStatus {
  port: number
  token: string
  pairingUrl: string
  connected: boolean
  clients: number
  extensionPath: string
}

/**
 * The string Settings copies and the extension popup pastes. Host is always
 * loopback; the token is the only secret.
 */
export function browserPairingUrl(port: number, token: string): string {
  return `http://127.0.0.1:${port}${BROWSER_PATH}?token=${encodeURIComponent(token)}`
}

/**
 * Accept the pairing URL, or `port:token`, or a bare token (caller keeps the
 * last port). Undefined when nothing usable is there.
 */
export function parseBrowserPairing(raw: string): { port?: number; token: string } | undefined {
  const trimmed = raw.trim()
  if (!trimmed) return undefined
  try {
    const url = new URL(trimmed)
    const token = url.searchParams.get('token')?.trim()
    if (token && url.pathname.replace(/\/$/, '') === BROWSER_PATH) {
      const host = url.hostname.replace(/^\[|\]$/g, '')
      if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') return undefined
      const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80))
      return Number.isFinite(port) && port > 0 ? { port, token } : { token }
    }
  } catch {
    /* not a URL — try port:token */
  }
  const colon = trimmed.match(/^(\d{2,5}):([0-9a-fA-F]{16,})$/)
  if (colon) return { port: Number(colon[1]), token: colon[2]! }
  if (/^[0-9a-fA-F]{16,}$/.test(trimmed)) return { token: trimmed }
  return undefined
}

export function isBrowserBridgeOrigin(origin: string | undefined): boolean {
  if (origin === undefined) return true
  let parsed: URL
  try {
    parsed = new URL(origin)
  } catch {
    return false
  }
  if (parsed.protocol === 'chrome-extension:' || parsed.protocol === 'moz-extension:') {
    return true
  }
  const host = parsed.hostname.replace(/^\[|\]$/g, '')
  return host === '127.0.0.1' || host === 'localhost' || host === '::1'
}
