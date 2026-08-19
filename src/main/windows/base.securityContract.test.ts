import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Security contract: every Vertragus window is built from baseWebPreferences.
 * This test greps the source so the flags cannot be silently flipped.
 *
 * The file list is DERIVED, not maintained: every non-test module in this
 * directory is checked, and the ones that construct a BrowserWindow must build
 * it from the shared base. A hand-kept list is how providerEditor.ts went
 * unlisted for months — a new window file is now covered the moment it exists.
 */
const windowsDir = __dirname

const moduleFiles = readdirSync(windowsDir)
  .filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts'))
  .sort()

const contents = new Map(
  moduleFiles.map((file) => [file, readFileSync(join(windowsDir, file), 'utf8')] as const)
)

/** The modules that actually open windows — everything else is pure logic. */
const windowBuilders = moduleFiles.filter((file) =>
  /new BrowserWindow\(/.test(contents.get(file)!)
)

describe('window security contract', () => {
  const src = contents.get('base.ts')!

  it('keeps the sandbox posture', () => {
    expect(src).toMatch(/sandbox:\s*true/)
    expect(src).toMatch(/contextIsolation:\s*true/)
    expect(src).toMatch(/nodeIntegration:\s*false/)
    expect(src).toMatch(/webSecurity:\s*true/)
  })

  it('actually derived a window list — the glob is not silently empty', () => {
    expect(windowBuilders.length).toBeGreaterThanOrEqual(6)
    expect(windowBuilders).toContain('panel.ts')
    expect(windowBuilders).toContain('cliWindow.ts')
    expect(windowBuilders).toContain('providerEditor.ts')
  })

  it('never weakens the posture anywhere in the windows layer', () => {
    for (const [file, content] of contents) {
      expect(content, file).not.toMatch(/sandbox:\s*false/)
      expect(content, file).not.toMatch(/contextIsolation:\s*false/)
      expect(content, file).not.toMatch(/nodeIntegration:\s*true/)
      expect(content, file).not.toMatch(/webSecurity:\s*false/)
    }
  })

  /**
   * A window that builds its own `webPreferences` instead of spreading the
   * shared base is how the sandbox gets lost quietly — the flags above would
   * still be intact in base.ts while the new window ignores them.
   */
  it('builds every window from the shared base options and secures it', () => {
    for (const file of windowBuilders) {
      if (file === 'base.ts') continue
      const content = contents.get(file)!
      expect(content, file).toMatch(/(glassWindowOptions|baseWebPreferences)\(\)/)
      expect(content, file).toMatch(/secureWindow\(/)
    }
  })
})
