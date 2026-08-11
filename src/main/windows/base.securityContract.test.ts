import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Security contract: every Vertragus window is built from baseWebPreferences.
 * This test greps the source so the flags cannot be silently flipped.
 */
describe('window security contract', () => {
  const src = readFileSync(join(__dirname, 'base.ts'), 'utf8')

  it('keeps the sandbox posture', () => {
    expect(src).toMatch(/sandbox:\s*true/)
    expect(src).toMatch(/contextIsolation:\s*true/)
    expect(src).toMatch(/nodeIntegration:\s*false/)
    expect(src).toMatch(/webSecurity:\s*true/)
  })

  it('never weakens the posture anywhere in the windows layer', () => {
    const files = [
      'base.ts',
      'panel.ts',
      'cliWindow.ts',
      'profileEditor.ts',
      'settingsWindow.ts',
      'zoneOverlay.ts'
    ]
    for (const file of files) {
      const content = readFileSync(join(__dirname, file), 'utf8')
      expect(content).not.toMatch(/sandbox:\s*false/)
      expect(content).not.toMatch(/contextIsolation:\s*false/)
      expect(content).not.toMatch(/nodeIntegration:\s*true/)
      expect(content).not.toMatch(/webSecurity:\s*false/)
    }
  })

  /**
   * A window that builds its own `webPreferences` instead of spreading the
   * shared base is how the sandbox gets lost quietly — the flags above would
   * still be intact in base.ts while the new window ignores them.
   */
  it('builds every window from the shared base options', () => {
    const files = ['panel.ts', 'cliWindow.ts', 'profileEditor.ts', 'settingsWindow.ts', 'zoneOverlay.ts']
    for (const file of files) {
      const content = readFileSync(join(__dirname, file), 'utf8')
      expect(content, file).toMatch(/(glassWindowOptions|baseWebPreferences)\(\)/)
      expect(content, file).toMatch(/secureWindow\(/)
    }
  })
})
