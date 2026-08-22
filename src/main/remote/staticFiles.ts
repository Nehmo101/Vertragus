/**
 * A minimal static-file server for the built remote web client.
 *
 * It serves exactly one directory (`out/remote`), with a hard path-traversal
 * guard: the resolved path must stay inside the root, or the request is a 403.
 * Unknown routes fall back to `index.html` so the client's hash routing works
 * on a deep link. Kept tiny and dependency-free — this is the house style
 * (raw `node:http`, no express) and the whole surface a remote attacker could
 * probe for a file-read.
 */
import { normalize, resolve, sep } from 'node:path'

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  // The PWA manifest — served with its own type so iOS/Android accept it.
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.map': 'application/json; charset=utf-8'
}

export function contentTypeFor(pathname: string): string {
  const dot = pathname.lastIndexOf('.')
  const ext = dot >= 0 ? pathname.slice(dot).toLowerCase() : ''
  return CONTENT_TYPES[ext] ?? 'application/octet-stream'
}

export type StaticResolution =
  | { kind: 'file'; absolutePath: string; contentType: string }
  | { kind: 'forbidden' }

/**
 * Map a request pathname to a file inside `root`, or reject a traversal.
 * A path that escapes the root (`..`, absolute, encoded separator) is
 * `forbidden`; an unmatched path resolves to `index.html` (SPA fallback).
 * This is pure — it decides the path; the caller reads the file (and a
 * missing file is the caller's 404).
 */
export function resolveStaticPath(root: string, pathname: string): StaticResolution {
  let decoded: string
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    return { kind: 'forbidden' }
  }
  // A NUL byte truncates a path in many filesystem calls — refuse outright.
  if (decoded.includes('\0')) return { kind: 'forbidden' }
  const rel = decoded === '/' || decoded === '' ? 'index.html' : decoded.replace(/^\/+/, '')
  const rootResolved = resolve(root)
  const candidate = resolve(rootResolved, normalize(rel))
  if (candidate !== rootResolved && !candidate.startsWith(rootResolved + sep)) {
    return { kind: 'forbidden' }
  }
  return { kind: 'file', absolutePath: candidate, contentType: contentTypeFor(candidate) }
}

/** The SPA fallback path — the client bundle's entry. */
export function indexPath(root: string): string {
  return resolve(root, 'index.html')
}

/**
 * The `connect-src` directive as `index.html` spells it, with the semicolons
 * that surround it INSIDE the policy — the page also discusses the directive in
 * prose above the tag, and a bare match would rewrite the comment and leave the
 * policy alone. `staticFiles.test.ts` asserts the real `index.html` still
 * contains this exact text, so a rewrite of the policy that drops it, respells
 * it, or moves it to either end fails the suite instead of silently disabling
 * this.
 */
const CONNECT_SRC_SELF = "; connect-src 'self';"

/**
 * The `host[:port]` a WebSocket source may be built from, or undefined when the
 * header is not something we are willing to put inside a CSP.
 *
 * The Host header has already passed `isRequestAllowed` before this runs (it
 * must equal the bind address or a loopback name), so this is not the security
 * check — it is the syntactic one. It re-parses through `URL` and re-serialises
 * from the parsed result, so nothing an attacker could smuggle past the earlier
 * check (a `;` that ends the directive, a newline, a second source expression)
 * can reach the policy text: anything that does not come back as a plain
 * host-and-port is refused outright and the page is served untouched.
 *
 * IPv6 literals are refused for a different reason: CSP's host-source grammar
 * has no production for a bracketed IPv6 address, so browsers drop the whole
 * source expression. Refusing here leaves such a page on the bare `'self'` it
 * has today rather than shipping a directive that reads as protection and is
 * not one.
 */
export function webSocketHost(hostHeader: string | undefined): string | undefined {
  if (!hostHeader) return undefined
  let host: string
  try {
    host = new URL(`http://${hostHeader}`).host
  } catch {
    return undefined
  }
  return /^[a-zA-Z0-9.-]+(:\d{1,5})?$/.test(host) ? host : undefined
}

/**
 * Name this page's own WebSocket origin in its CSP, instead of trusting every
 * browser to derive it.
 *
 * `connect-src 'self'` already covers `ws://` to the same host and port — CSP3
 * says so, and Chromium and current Firefox implement it. iOS Safari is the one
 * device this client was written for, WebKit blocked exactly this for years,
 * and if it blocks it the client does not connect AT ALL: not a degraded
 * feature, a blank page over Tailscale. The cost of being explicit is one extra
 * source expression naming one host and one port — narrower than the `ws: wss:`
 * that was rejected for allowing a socket to anywhere on the internet, on a
 * page whose `localStorage` holds the pairing token — and it does not depend on
 * which browser is reading it.
 *
 * Templated per request rather than baked into the file because the server does
 * not know at build time which of its allowed names the phone will use: the
 * bind address, `localhost` from the desktop's own browser, a loopback literal.
 * The origin the page was actually loaded from is the only one its socket can
 * use, and that is exactly what the Host header carries.
 *
 * `ws://` only: this listener is plain `node:http`, so a page served from it is
 * never `https:` and the client never picks `wss:`.
 */
export function withWebSocketConnectSrc(html: string, hostHeader: string | undefined): string {
  const host = webSocketHost(hostHeader)
  if (!host || !html.includes(CONNECT_SRC_SELF)) return html
  return html.replace(CONNECT_SRC_SELF, `; connect-src 'self' ws://${host};`)
}
