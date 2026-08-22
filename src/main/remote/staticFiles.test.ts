import { readFileSync } from 'node:fs'
import { sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  contentTypeFor,
  resolveStaticPath,
  webSocketHost,
  withWebSocketConnectSrc
} from './staticFiles'

const root = sep === '\\' ? 'C:\\app\\out\\remote' : '/app/out/remote'

describe('contentTypeFor', () => {
  it('maps known extensions and falls back to octet-stream', () => {
    expect(contentTypeFor('/index.html')).toContain('text/html')
    expect(contentTypeFor('/assets/app.js')).toContain('text/javascript')
    expect(contentTypeFor('/assets/app.css')).toContain('text/css')
    expect(contentTypeFor('/font.woff2')).toBe('font/woff2')
    expect(contentTypeFor('/mystery.bin')).toBe('application/octet-stream')
  })
})

describe('resolveStaticPath', () => {
  it('serves index.html for the root', () => {
    const result = resolveStaticPath(root, '/')
    expect(result).toMatchObject({ kind: 'file' })
    if (result.kind === 'file') expect(result.absolutePath.endsWith('index.html')).toBe(true)
  })

  it('serves a nested asset', () => {
    const result = resolveStaticPath(root, '/assets/app.js')
    expect(result).toMatchObject({ kind: 'file', contentType: expect.stringContaining('javascript') })
  })

  it('refuses a traversal out of the root', () => {
    expect(resolveStaticPath(root, '/../../etc/passwd').kind).toBe('forbidden')
    expect(resolveStaticPath(root, '/../secret').kind).toBe('forbidden')
  })

  it('refuses an encoded traversal and a NUL byte', () => {
    expect(resolveStaticPath(root, '/%2e%2e/%2e%2e/etc/passwd').kind).toBe('forbidden')
    expect(resolveStaticPath(root, '/app%00.js').kind).toBe('forbidden')
  })

  it('refuses a malformed percent-encoding rather than guessing', () => {
    expect(resolveStaticPath(root, '/%').kind).toBe('forbidden')
  })

  it('keeps a legitimate deep path inside the root', () => {
    const result = resolveStaticPath(root, '/assets/fonts/mono.woff2')
    expect(result.kind).toBe('file')
    if (result.kind === 'file') expect(result.absolutePath.startsWith(root)).toBe(true)
  })
})

describe('the CSP names the page\'s own WebSocket origin', () => {
  /*
   * The client is a page on plain http: talking ws: to the host it came from.
   * `connect-src 'self'` covers that by spec, and every browser but the one
   * that matters can be relied on to agree; WebKit blocked it for years. A
   * directive that is wrong here is not a degraded feature, it is a client that
   * never connects — so the origin is named rather than derived.
   */
  // The SOURCE page: what the server serves is the built copy in `out/remote`,
  // which does not exist in a fresh checkout. Vite rewrites the script and link
  // tags around this meta and copies its content verbatim, so the source is the
  // honest thing to assert against and the only thing always present.
  const page = readFileSync(
    fileURLToPath(new URL('../../remoteClient/index.html', import.meta.url)),
    'utf8'
  )

  /**
   * The BUILT page, when there is one. Everything above asserts against the
   * source, which is what a fresh checkout has — but the server serves
   * `out/remote/index.html`, and `withWebSocketConnectSrc` returns the html
   * untouched when it cannot find its anchor. So a Vite change that rewrote
   * that meta tag would leave every assertion above green while the
   * substitution silently no-opped on every response. This closes that gap
   * whenever a build exists, and says so when one does not.
   */
  const builtPage = ((): string | undefined => {
    try {
      return readFileSync(fileURLToPath(new URL('../../../out/remote/index.html', import.meta.url)), 'utf8')
    } catch {
      return undefined
    }
  })()

  it.skipIf(builtPage === undefined)('templates the page the server actually serves', () => {
    const served = withWebSocketConnectSrc(builtPage!, '100.64.1.5:9482')
    expect(served, 'the built page lost the anchor the substitution matches on').not.toBe(builtPage)
    expect(served).toContain("connect-src 'self' ws://100.64.1.5:9482;")
  })

  it('is templating a directive the page actually contains', () => {
    // Self-check AND the reachability guard: the substitution matches on this
    // exact text, so a rewrite of the policy that drops or respells it would
    // otherwise disable the whole mechanism in silence.
    expect(page).toContain("; connect-src 'self';")
    // ... and the schemes it exists to avoid needing stay out of the file.
    expect(page).not.toContain('ws: wss:')
  })

  it('appends exactly one host and port to the real page', () => {
    const served = withWebSocketConnectSrc(page, '100.64.1.5:9482')
    expect(served).toContain("connect-src 'self' ws://100.64.1.5:9482;")
    // Nothing else in the policy moved.
    expect(served).toContain("default-src 'self'")
    expect(served).toContain("form-action 'none'")
    expect(served.length).toBe(page.length + " ws://100.64.1.5:9482".length)
  })

  it('serves whatever origin the page was loaded from, not the bind address', () => {
    // A desktop browser reaching its own app over loopback and a phone reaching
    // it over the tailnet are the same file with different Host headers, and
    // only the origin the page was loaded from can be the origin of its socket.
    expect(withWebSocketConnectSrc(page, 'localhost:9482')).toContain(
      "connect-src 'self' ws://localhost:9482;"
    )
  })

  it('leaves the page alone when there is no host to name', () => {
    expect(withWebSocketConnectSrc(page, undefined)).toBe(page)
    // An IPv6 literal has no CSP host-source production, so a browser would
    // drop the expression: better the bare `'self'` than a directive that reads
    // as protection and is not one.
    expect(withWebSocketConnectSrc(page, '[fd7a::1]:9482')).toBe(page)
  })

  it('never lets a Host header write a second directive', () => {
    // The Host header has passed `isRequestAllowed` before this runs, so this
    // is the syntactic backstop, not the security check — but a policy is text,
    // and text assembled from a header is an injection until proven otherwise.
    for (const hostile of [
      // `URL` alone rejects these — they carry a space or an angle bracket.
      "evil; script-src 'unsafe-inline'",
      'evil.example\n<script>',
      "a' 'unsafe-eval",
      '',
      '   ',
      // These do NOT reach `URL`'s rejection: `new URL('http://evil.example;script-src')`
      // parses, and its `.host` keeps the semicolon. Only the character
      // allow-list stops them, so without one of these the test would pass
      // against a `webSocketHost` that trusted `URL` and dropped the regex —
      // which is exactly the simplification it exists to prevent.
      'evil.example;script-src',
      "evil.example'"
    ]) {
      expect(webSocketHost(hostile)).toBeUndefined()
      expect(withWebSocketConnectSrc(page, hostile)).toBe(page)
    }
  })

  it('keeps only the host and port, whatever else the header carried', () => {
    // `URL` normalisation is the reason the regex above can be this simple: a
    // path, a query or credentials never reach the test, let alone the policy.
    expect(webSocketHost('evil.example/../..')).toBe('evil.example')
    expect(webSocketHost('host.example:9482/x?y=1')).toBe('host.example:9482')
  })

  it('accepts the plain host-and-port forms the server actually binds', () => {
    expect(webSocketHost('100.64.1.5:9482')).toBe('100.64.1.5:9482')
    expect(webSocketHost('localhost:9482')).toBe('localhost:9482')
    expect(webSocketHost('127.0.0.1:9482')).toBe('127.0.0.1:9482')
    // A default-port request carries no port, and neither should the source.
    expect(webSocketHost('desktop.tailnet.ts.net')).toBe('desktop.tailnet.ts.net')
  })
})
