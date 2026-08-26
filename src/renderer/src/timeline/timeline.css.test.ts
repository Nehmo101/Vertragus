import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const css = readFileSync(join(__dirname, 'timeline.css'), 'utf8')

/** Body of the first top-level `selector { ... }` (selector at column 0). */
function ruleBody(selector: string): string {
  const start = css.indexOf(`\n${selector} {`)
  expect(start, `${selector} {`).toBeGreaterThan(-1)
  const open = css.indexOf('{', start)
  const close = css.indexOf('}', open)
  expect(close).toBeGreaterThan(open)
  return css.slice(open, close + 1)
}

describe('timeline app-region', () => {
  it('still contains a .tl { rule and a .tl-body { rule', () => {
    expect(css).toMatch(/^\.tl \{/m)
    expect(css).toMatch(/^\.tl-body \{/m)
  })

  it('keeps window chrome drag on .tl', () => {
    expect(ruleBody('.tl')).toMatch(/-webkit-app-region:\s*drag/)
  })

  it('opts .tl-body out of the drag region so wheel reaches Chromium', () => {
    expect(ruleBody('.tl-body')).toMatch(/-webkit-app-region:\s*no-drag/)
  })

  it('opts controls out of the drag region', () => {
    expect(css).toMatch(/\.tl button[\s\S]*-webkit-app-region:\s*no-drag/)
    expect(ruleBody('.tl-close')).toMatch(/-webkit-app-region:\s*no-drag/)
  })
})
