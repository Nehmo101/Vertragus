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
