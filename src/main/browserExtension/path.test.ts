import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveChromiumExtensionDir } from './path'

describe('resolveChromiumExtensionDir', () => {
  it('prefers the packaged extraResources folder when it has a manifest', () => {
    const root = join('/tmp', `vertragus-ext-${Date.now()}`)
    const packaged = join(root, 'chromium-extension')
    mkdirSync(packaged, { recursive: true })
    writeFileSync(join(packaged, 'manifest.json'), '{}')
    expect(resolveChromiumExtensionDir({ resourcesPath: root, candidates: [join(root, 'dev')] })).toBe(
      packaged
    )
  })

  it('falls back to the first candidate that has a manifest', () => {
    const root = join('/tmp', `vertragus-ext-dev-${Date.now()}`)
    const dev = join(root, 'extensions', 'chromium')
    mkdirSync(dev, { recursive: true })
    writeFileSync(join(dev, 'manifest.json'), '{}')
    expect(
      resolveChromiumExtensionDir({
        resourcesPath: join(root, 'missing'),
        candidates: [join(root, 'nope'), dev]
      })
    ).toBe(dev)
  })

  it('returns the packaged path even when nothing is on disk (Settings still shows it)', () => {
    const resourcesPath = join('/tmp', 'vertragus-ext-none')
    expect(resolveChromiumExtensionDir({ resourcesPath })).toBe(
      join(resourcesPath, 'chromium-extension')
    )
    expect(existsSync(join(resourcesPath, 'chromium-extension', 'manifest.json'))).toBe(false)
  })
})
