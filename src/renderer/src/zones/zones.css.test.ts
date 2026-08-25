/**
 * The zone overlay chrome must stay on a small work area.
 *
 * The bottom slab used to be one nowrap flex row that grew with every role
 * chip. Combined with the overlay's `overflow: hidden`, that painted Save
 * past the right edge of a laptop display. These checks read the CSS and the
 * overlay markup: a layout engine is not in this test runner, so the files
 * are what would silently regress.
 *
 * Self-checks: every selector/class this file names must still exist, or the
 * scan is pointing at nothing and would green a revert.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const dir = dirname(fileURLToPath(import.meta.url))
const css = readFileSync(join(dir, 'zones.css'), 'utf8')
const tsx = readFileSync(join(dir, 'ZonesApp.tsx'), 'utf8')

function block(selector: string): string {
  const start = css.indexOf(`\n${selector} {`)
  if (start < 0) throw new Error(`self-check: ${selector} is gone`)
  const open = css.indexOf('{', start)
  const close = css.indexOf('\n}', open)
  if (open < 0 || close < 0) throw new Error(`self-check: ${selector} is not a block`)
  return css.slice(open, close)
}

describe('zone overlay chrome stays on a small work area', () => {
  it('still contains the overlay, bar, tools, palette, actions and hint', () => {
    expect(block('.zones').length).toBeGreaterThan(0)
    expect(block('.zones-bar').length).toBeGreaterThan(0)
    expect(block('.zones-bar-tools').length).toBeGreaterThan(0)
    expect(block('.zones-palette').length).toBeGreaterThan(0)
    expect(block('.zones-bar-actions').length).toBeGreaterThan(0)
    expect(block('.zones-hint').length).toBeGreaterThan(0)
  })

  it('clips the overlay so an overflowing slab cannot paint off-screen', () => {
    expect(block('.zones')).toMatch(/overflow:\s*hidden/)
  })

  it('lets the bottom bar wrap inside the overlay instead of growing past it', () => {
    const bar = block('.zones-bar')
    expect(bar).toMatch(/flex-wrap:\s*wrap/)
    expect(bar).toMatch(/min-width:\s*0/)
    expect(bar).toMatch(/max-width:\s*calc\(100% - 32px\)/)
    expect(bar).toMatch(/box-sizing:\s*border-box/)
    expect(bar).not.toMatch(/flex-wrap:\s*nowrap/)
    expect(bar).not.toMatch(/max-width:\s*\d+(\.\d+)?vw/)
  })

  it('lets the palette wrap so role chips do not stretch the slab', () => {
    const palette = block('.zones-palette')
    expect(palette).toMatch(/flex-wrap:\s*wrap/)
    expect(palette).toMatch(/min-width:\s*0/)
    expect(palette).not.toMatch(/flex-wrap:\s*nowrap/)
  })

  it('keeps Save/Cancel in a cluster that can sit on its own row', () => {
    const tools = block('.zones-bar-tools')
    expect(tools).toMatch(/flex-wrap:\s*wrap/)
    expect(tools).toMatch(/min-width:\s*0/)
    const actions = block('.zones-bar-actions')
    expect(actions).toMatch(/flex-wrap:\s*wrap/)
    expect(actions).toMatch(/min-width:\s*0/)
    expect(actions).toMatch(/margin-inline-start:\s*auto/)
    expect(actions).toMatch(/justify-content:\s*flex-end/)
  })

  it('lets the hint pill wrap instead of overflowing the overlay', () => {
    const hint = block('.zones-hint')
    expect(hint).toMatch(/flex-wrap:\s*wrap/)
    expect(hint).toMatch(/min-width:\s*0/)
    expect(hint).toMatch(/max-width:\s*calc\(100% - 32px\)/)
  })

  it('groups tools and actions in the overlay markup, with Save last in actions', () => {
    const toolsOpen = tsx.indexOf('className="zones-bar-tools"')
    const actionsOpen = tsx.indexOf('className="zones-bar-actions"')
    if (toolsOpen < 0) throw new Error('self-check: zones-bar-tools is gone')
    if (actionsOpen < 0) throw new Error('self-check: zones-bar-actions is gone')
    const actions = tsx.slice(actionsOpen)
    const saveKey = actions.indexOf("t('common.save')")
    const cancelKey = actions.indexOf("t('zones.cancel')")
    if (saveKey < 0) throw new Error('self-check: common.save is gone from actions')
    if (cancelKey < 0) throw new Error('self-check: zones.cancel is gone from actions')
    expect(toolsOpen).toBeLessThan(actionsOpen)
    expect(saveKey).toBeGreaterThan(cancelKey)
    expect(tsx).not.toMatch(/zones-bar-spacer/)
  })
})
