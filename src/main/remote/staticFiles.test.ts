import { sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import { contentTypeFor, resolveStaticPath } from './staticFiles'

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
