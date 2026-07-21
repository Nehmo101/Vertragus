import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * Source-contract regressions for the window security anchors. These hardening
 * flags and the window-sender guards are the foundation the IPC authorization
 * (register.ts `assertNotVoiceWindow` / `requireMainWindow`) relies on; a silent
 * regression here would quietly widen the renderer trust boundary. Behavioural
 * testing would require a full Electron runtime, so we pin the source instead.
 */
const windowsSrc = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'windows.ts'), 'utf8')

function baseWebPreferencesBlock(): string {
  const match = windowsSrc.match(/function baseWebPreferences\(\)[\s\S]*?\n}/)
  expect(match, 'expected baseWebPreferences()').toBeTruthy()
  return match![0]
}

describe('windows.ts security anchors', () => {
  it('baseWebPreferences enables every renderer hardening flag', () => {
    const block = baseWebPreferencesBlock()
    expect(block).toMatch(/sandbox:\s*true/)
    expect(block).toMatch(/contextIsolation:\s*true/)
    expect(block).toMatch(/nodeIntegration:\s*false/)
    expect(block).toMatch(/webSecurity:\s*true/)
  })

  it('never weakens a hardening flag anywhere in the module', () => {
    expect(windowsSrc).not.toMatch(/sandbox:\s*false/)
    expect(windowsSrc).not.toMatch(/contextIsolation:\s*false/)
    expect(windowsSrc).not.toMatch(/nodeIntegration:\s*true/)
    expect(windowsSrc).not.toMatch(/webSecurity:\s*false/)
  })

  it('every window is created through baseWebPreferences (no bespoke webPreferences)', () => {
    // Each `webPreferences:` in a BrowserWindow config must be baseWebPreferences().
    const prefs = windowsSrc.match(/webPreferences:\s*[^,\n]+/g) ?? []
    expect(prefs.length).toBeGreaterThanOrEqual(3) // main, voice, pane
    for (const line of prefs) {
      expect(line).toMatch(/webPreferences:\s*baseWebPreferences\(\)/)
    }
  })

  it('window-sender guards check exact webContents identity and destruction', () => {
    for (const fn of ['isMainWindowSender', 'isVoiceWindowSender']) {
      const match = windowsSrc.match(new RegExp(String.raw`export function ${fn}\([\s\S]*?\n}`))
      expect(match, `expected ${fn}`).toBeTruthy()
      const block = match![0]
      expect(block).toMatch(/\.webContents === sender/)
      expect(block).toMatch(/!\w+\.isDestroyed\(\)/)
    }
  })
})
