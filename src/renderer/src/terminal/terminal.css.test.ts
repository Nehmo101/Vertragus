/**
 * Session chrome must stay a clickable overlay on the CLI window, never a
 * drag region and never above the greyhound boot overlay.
 *
 * A layout engine is not in this test runner, so the files are what would
 * silently regress. Self-checks: every selector/class this file names must
 * still exist, or the scan is pointing at nothing and would green a revert.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const dir = dirname(fileURLToPath(import.meta.url))
const css = readFileSync(join(dir, 'terminal.css'), 'utf8')
const sessionPane = readFileSync(join(dir, 'SessionPane.tsx'), 'utf8')
const terminalApp = readFileSync(join(dir, 'TerminalApp.tsx'), 'utf8')

function block(selector: string): string {
  const start = css.indexOf(`\n${selector} {`)
  if (start < 0) throw new Error(`self-check: ${selector} is gone`)
  const open = css.indexOf('{', start)
  const close = css.indexOf('\n}', open)
  if (open < 0 || close < 0) throw new Error(`self-check: ${selector} is not a block`)
  return css.slice(open, close)
}

describe('CLI session chrome stays an overlay, not a second TUI parser', () => {
  it('still contains the session overlay, rail mark, surface chip and boot overlay', () => {
    expect(block('.cli-session').length).toBeGreaterThan(0)
    expect(block('.cli-session-mark').length).toBeGreaterThan(0)
    expect(block('.cli-surface').length).toBeGreaterThan(0)
    expect(block('.cli-boot').length).toBeGreaterThan(0)
    expect(block('.cli-boot.is-waiting').length).toBeGreaterThan(0)
  })

  it('pins the session pane as an absolute overlay that is not a drag region', () => {
    const session = block('.cli-session')
    expect(session).toMatch(/position:\s*absolute/)
    expect(session).toMatch(/-webkit-app-region:\s*no-drag/)
    expect(session).toMatch(/pointer-events:\s*auto/)
    expect(session).toMatch(/z-index:\s*1/)
  })

  it('keeps the greyhound boot overlay above session chrome', () => {
    expect(block('.cli-boot')).toMatch(/z-index:\s*2/)
  })

  it('lets leftover Cursor approvals stay clickable while MCP is waiting', () => {
    expect(block('.cli-boot.is-waiting')).toMatch(/pointer-events:\s*none/)
  })

  it('sets the VERTRAGVS rail in the heading font, not a monospace TUI face', () => {
    expect(block('.cli-session-mark')).toMatch(/var\(--font-heading\)/)
    expect(sessionPane).toContain('VERTRAGVS')
    expect(sessionPane).toContain('className="cli-session"')
    expect(sessionPane).toContain('HoundLogo')
  })

  it('mounts the session pane from TerminalApp and peeks via the title-bar chip', () => {
    expect(terminalApp).toContain('<SessionPane')
    expect(terminalApp).toContain('className="cli-surface"')
    expect(terminalApp).toContain('effectiveCliSurface')
  })
})
