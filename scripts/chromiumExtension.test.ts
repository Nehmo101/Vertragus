/**
 * Guard: the unpacked Chromium extension ships as extraResources and talks
 * the `/browser` command protocol. A missing command or a loosened origin
 * would fail closed in production only after a user loaded it.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { BROWSER_COMMANDS, BROWSER_PATH } from '../src/shared/browserExtension'

const repoRoot = join(fileURLToPath(new URL('..', import.meta.url)))
const extDir = join(repoRoot, 'extensions', 'chromium')

describe('Chromium extension pack', () => {
  it('is an MV3 unpacked folder with the loopback pairing path', () => {
    const manifest = JSON.parse(readFileSync(join(extDir, 'manifest.json'), 'utf8')) as {
      manifest_version: number
      background?: { service_worker?: string }
      permissions?: string[]
      host_permissions?: string[]
    }
    expect(manifest.manifest_version).toBe(3)
    expect(manifest.background?.service_worker).toBe('background.js')
    expect(manifest.permissions).toEqual(expect.arrayContaining(['tabs', 'scripting', 'storage']))
    expect(manifest.host_permissions?.some((pattern) => pattern.includes('127.0.0.1'))).toBe(true)
  })

  it('handles every shared browser command and refuses eval', () => {
    const background = readFileSync(join(extDir, 'background.js'), 'utf8')
    for (const command of BROWSER_COMMANDS) {
      expect(background, command).toContain(`'${command}'`)
    }
    expect(background).toContain(BROWSER_PATH)
    expect(background).not.toMatch(/\beval\s*\(/)
    expect(background).toMatch(/hostname !== '127\.0\.0\.1'/)
  })

  it('content script snapshots refs that click/fill consume', () => {
    const content = readFileSync(join(extDir, 'content.js'), 'utf8')
    expect(content).toContain('data-vertragus-ref')
    expect(content).toContain("message.type === 'snapshot'")
    expect(content).toContain("message.type === 'click'")
    expect(content).toContain("message.type === 'fill'")
    expect(content).toContain("message.type === 'press'")
  })

  it('is listed as extraResources so the packaged app can reveal the folder', () => {
    const yaml = readFileSync(join(repoRoot, 'electron-builder.yml'), 'utf8')
    expect(yaml).toMatch(/from:\s*extensions\/chromium/)
    expect(yaml).toMatch(/to:\s*chromium-extension/)
  })
})
