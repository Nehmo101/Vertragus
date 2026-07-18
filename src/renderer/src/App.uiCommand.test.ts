import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const appSrc = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'App.tsx'), 'utf8')

describe('App uiCommand / voice route wiring', () => {
  it('ignores broadcast uiCommands in the voice overlay and pane windows', () => {
    expect(appSrc).toMatch(/onUiCommand/)
    expect(appSrc).toMatch(/#\/voice/)
    expect(appSrc).toMatch(/#\/pane/)
    expect(appSrc).toMatch(/applyUiCommand/)
    // Voice and pane windows must return before applying navigation/layout commands.
    expect(appSrc).toMatch(
      /route\.startsWith\(['"]#\/voice['"]\)\s*\|\|\s*route\.startsWith\(['"]#\/pane['"]\)\s*\)\s*return/
    )
  })

  it('mounts VoiceOverlay only on the #/voice route', () => {
    expect(appSrc).toMatch(/hash\s*===\s*['"]#\/voice['"]/)
    expect(appSrc).toMatch(/<VoiceOverlay\s*\/>/)
  })
})
