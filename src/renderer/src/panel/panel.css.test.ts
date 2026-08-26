import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const css = readFileSync(join(__dirname, 'panel.css'), 'utf8')

/** Body of the first top-level `selector { ... }` (selector at column 0). */
function ruleBody(selector: string): string {
  const start = css.indexOf(`\n${selector} {`)
  expect(start, `${selector} {`).toBeGreaterThan(-1)
  const open = css.indexOf('{', start)
  const close = css.indexOf('}', open)
  expect(close).toBeGreaterThan(open)
  return css.slice(open, close + 1)
}

describe('panel app-region', () => {
  it('still contains a .panel { rule and a .panel-scroll { rule', () => {
    expect(css).toMatch(/^\.panel \{/m)
    expect(css).toMatch(/^\.panel-scroll \{/m)
  })

  it('keeps window chrome drag on .panel', () => {
    expect(ruleBody('.panel')).toMatch(/-webkit-app-region:\s*drag/)
  })

  it('opts .panel-scroll out of the drag region so wheel reaches Chromium', () => {
    expect(ruleBody('.panel-scroll')).toMatch(/-webkit-app-region:\s*no-drag/)
  })

  it('opts textarea out of the drag region so Windows can deliver image drop', () => {
    expect(css).toMatch(/\.panel textarea/)
    const start = css.indexOf('.panel button,')
    const block = css.slice(start, css.indexOf('}', start) + 1)
    expect(block).toMatch(/\.panel textarea/)
    expect(block).toMatch(/-webkit-app-region:\s*no-drag/)
  })
})
