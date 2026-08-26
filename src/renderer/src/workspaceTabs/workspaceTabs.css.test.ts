import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const css = readFileSync(join(__dirname, 'workspaceTabs.css'), 'utf8')

describe('workspace tab chrome app-region', () => {
  it('keeps the strip a drag region', () => {
    expect(css).toMatch(/\.wt-bar[\s\S]*-webkit-app-region:\s*drag/)
  })

  it('opts tab buttons and window controls out of the drag region', () => {
    expect(css).toMatch(/\.wt-tab,[\s\S]*\.wt-btn \{[\s\S]*-webkit-app-region:\s*no-drag/)
  })
})
