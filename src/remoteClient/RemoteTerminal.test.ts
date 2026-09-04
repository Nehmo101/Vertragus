/**
 * Guard test for the invariants that live in `RemoteTerminal.tsx` and
 * `TerminalReader.tsx` themselves.
 *
 * There is no DOM runner in this project, so the components cannot be
 * rendered. Everything they *decide* has been pushed into pure modules that
 * are tested next to them — `terminalRows`, `terminalAttach`, `terminalBuffer`,
 * `terminalFont`, `terminalChrome`. What is left in the components is a
 * handful of rules about how those decisions are wired up, and until now each
 * one was stated in a comment. A comment is not a guard: this file reads the
 * source and fails if a rule stops holding, which is the same instrument
 * `i18n.test.ts` and `docsTwins.test.ts` use for their cross-cutting rules.
 *
 * Every assertion below is paired with a self-check on its own scanning, so a
 * regex that quietly stops matching fails loudly instead of passing vacuously.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const read = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`./${name}`, import.meta.url)), 'utf8')

const source = read('RemoteTerminal.tsx')
const reader = read('TerminalReader.tsx')
const css = read('terminal.css')
const sheets = { 'terminal.css': css, 'styles.css': read('styles.css'), 'overview.css': read('overview.css') }
const remote = read('useRemote.ts')
const viewport = read('useVisualViewport.ts')

/** The dependency array closing the effect that builds the parser. */
function terminalEffectDeps(): string[] {
  const start = reader.indexOf('new Terminal(')
  if (start < 0) throw new Error('self-check: the reader effect no longer builds a Terminal')
  const close = reader.indexOf('\n  }, [', start)
  if (close < 0) throw new Error('self-check: the reader effect no longer ends in a dep array')
  const end = reader.indexOf('])', close)
  if (end < 0) throw new Error('self-check: the dep array is not closed')
  return reader
    .slice(close + '\n  }, ['.length, end)
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '')
}

/** One top-level rule block of a sheet, by its selector line. */
function block(sheet: string, selector: string): string {
  const start = sheet.indexOf(selector)
  if (start < 0) throw new Error(`self-check: ${selector} is gone`)
  const open = sheet.indexOf('{', start)
  const close = sheet.indexOf('\n}', open)
  if (open < 0 || close < 0) throw new Error(`self-check: ${selector} is not a block`)
  return sheet.slice(open, close)
}

describe('the parser is built once per agent', () => {
  it('finds a dependency array to check at all', () => {
    // Self-check for every assertion below: the scan above has to be pointing
    // at something before its verdict on that something means anything.
    expect(terminalEffectDeps().length).toBeGreaterThan(0)
  })

  it('keeps everything that re-renders out of the effect deps', () => {
    // `useRemote()` returns a fresh object every render, so an `api` dep is an
    // effect that re-runs on every workspace push — which rebuilds the buffer,
    // throws away the scrollback and drops the reader at the bottom. That was
    // the original bug; `exhaustive-deps` does not report a *superfluous*
    // dependency in v7 of the plugin, so this does.
    const deps = terminalEffectDeps()
    expect(deps).not.toContain('api')
    expect(deps).not.toContain('fontSize')
    expect(deps).not.toContain('onMeta')
    expect(deps).not.toContain('onFollowingChange')
  })

  it('depends on the agent and nothing else', () => {
    expect(terminalEffectDeps()).toEqual(['agentId'])
  })
})

describe('the phone never reshapes the shared PTY', () => {
  it('has no resize to call', () => {
    // The PTY is the desktop's: a `resize` frame is a real SIGWINCH that
    // repaints the agent's TUI on the desktop user's screen. The earlier
    // passes rationed it; this one has no way to send it at all.
    const api = remote.slice(remote.indexOf('export interface RemoteApi {'), remote.indexOf('\n}', remote.indexOf('export interface RemoteApi {')))
    expect(api.length, 'self-check: RemoteApi interface found').toBeGreaterThan(100)
    expect(api).not.toMatch(/\bresize\(/)
    expect(remote).not.toContain("type: 'resize'")
    expect(source + reader).not.toMatch(/api(Ref\.current)?\.resize\(/)
  })

  it('sizes the parser from the snapshot, before anything is written', () => {
    // The snapshot names the PTY's `cols`/`rows`; cursor movement and erase
    // sequences only land where the program meant them on that grid.
    const handler = reader.indexOf('onSnapshot: (snapshot, cols, rows,')
    expect(handler, 'self-check: the snapshot handler names cols and rows').toBeGreaterThan(-1)
    const sized = reader.indexOf('term.resize(cols, rows)', handler)
    const planned = reader.indexOf('planAttach({ snapshot, written })', handler)
    expect(sized).toBeGreaterThan(handler)
    expect(planned).toBeGreaterThan(sized)
  })

  it('opens the parser without a renderer', () => {
    expect(reader).toContain("from '@xterm/headless'")
    expect(source + reader).not.toContain("from '@xterm/xterm'")
    expect(source + reader).not.toContain('addon-fit')
  })
})

describe('the reader is a native scroller', () => {
  it('grants the browser the vertical pan and contains its overscroll', () => {
    const rule = block(css, '\n.reader {')
    expect(rule).toContain('overflow-y: auto')
    expect(rule).toMatch(/touch-action:[^;]*\bpan-y\b/)
    expect(rule).toContain('overscroll-behavior: contain')
  })

  it('has no touch listener that could take the gesture back', () => {
    // A `touchmove` handler is the door every previous scroller walked
    // through; the reader owns none. (Passive `touchstart`/`touchend` only
    // note whether a finger is down.)
    expect(source).not.toContain('touchmove')
    expect(reader).not.toContain('touchmove')
    expect(reader).not.toContain('preventDefault')
  })

  it('writes the scroll position in exactly one place, to follow', () => {
    const writes = [...reader.matchAll(/\.scrollTop\s*=[^=]/g)]
    expect(writes).toHaveLength(1)
    const snap = reader.indexOf('const snapToLatest = ')
    expect(snap, 'self-check: snapToLatest exists').toBeGreaterThan(-1)
    const next = reader.indexOf('\n    const ', snap + 1)
    expect(writes[0]!.index).toBeGreaterThan(snap)
    expect(writes[0]!.index).toBeLessThan(next)
    // And never under a finger.
    expect(reader.slice(snap, next)).toContain('if (touchDown)')
  })

  it('renders one frame per burst of writes', () => {
    expect(reader).toContain('if (disposed || frame !== 0) return')
    expect(reader).toContain('frame = window.requestAnimationFrame(render)')
  })
})

describe('the overlay is pinned to the layout viewport', () => {
  it('uses inset: 0 and no viewport variable', () => {
    expect(block(css, '.terminal-view {')).toContain('inset: 0')
    expect(block(sheets['overview.css'], '.terminal-pending {')).toContain('inset: 0')
    for (const [name, sheet] of Object.entries(sheets)) {
      expect(sheet, name).not.toContain('--vv-height')
      expect(sheet, name).not.toContain('--vv-offset-top')
    }
  })

  it('publishes only the keyboard inset', () => {
    expect(viewport).toContain("'--keyboard-inset'")
    expect(viewport).not.toContain('--vv-height')
    expect(viewport).not.toContain('--vv-offset-top')
  })
})

describe('a re-attach continues the buffer instead of rebuilding it', () => {
  it('resets only on the plan that earned it', () => {
    // A phone reconnects routinely — liveness probe, visibilitychange,
    // pageshow, online — and every reconnect brings a fresh snapshot. An
    // unconditional reset throws away the buffer, the alternate screen and
    // the reader's place, all to replay a host buffer that is capped in
    // characters and trimmed from the head.
    const resets = [...reader.matchAll(/term\.reset\(\)/g)]
    expect(resets).toHaveLength(1)
    expect(reader).toMatch(/if \(plan\.kind === 'replay'\) \{\s*term\.reset\(\)/)
  })

  it('routes the snapshot through the attach plan', () => {
    expect(reader).toContain('planAttach({ snapshot, written })')
    expect(reader).toContain('attachScroll(plan, followRef.current)')
  })
})

describe('the clipboard fallback is the only path the phone ever takes', () => {
  /** Every helper the fallback is made of, up to the component itself. */
  function clipboardFallback(): string {
    const start = source.indexOf('function copyThroughEvent(')
    if (start < 0) throw new Error('self-check: the fallback no longer starts at copyThroughEvent')
    const end = source.indexOf('\nexport function RemoteTerminal(', start)
    if (end < 0) throw new Error('self-check: the fallback is no longer followed by the component')
    return source.slice(start, end)
  }

  it('takes the payload from the copy event rather than from the selection', () => {
    // Whether an engine serialises a given selection the way this meant it is
    // the part no reading of a spec settles. Answering the event settles it:
    // the bytes come from here, and the selection only has to exist.
    const fallback = clipboardFallback()
    expect(fallback).toContain("document.addEventListener('copy', onCopy)")
    expect(fallback).toContain("event.clipboardData.setData('text/plain', text)")
    expect(fallback).toContain('event.preventDefault()')
  })

  it('reports a copy nobody handled as a failure', () => {
    // `execCommand` answers true for a command that ran; it does not answer
    // for what reached the clipboard. Reporting success over an empty
    // clipboard is worse than the note that says it failed.
    expect(clipboardFallback()).toContain("document.execCommand('copy') && handled")
  })

  it('gives the second attempt the focus its mechanism needs', () => {
    // `setSelectionRange` on an unfocused textarea writes two numbers onto the
    // element and nothing else: a text control's selection becomes the frame's
    // — which is what the copy command reads — only while it has focus. Losing
    // that call is how this broke the last time.
    const fallback = clipboardFallback()
    const start = fallback.indexOf('function copyFromTextarea(')
    expect(start).toBeGreaterThan(-1)
    const attempt = fallback.slice(start)
    expect(attempt).toContain('carrier.focus({ preventScroll: true })')
    expect(attempt).toContain('carrier.select()')
  })

  it('touches nothing between installing the selection and copying', () => {
    // Changing `contentEditable` or `readOnly` rebuilds WebKit's editing state
    // and takes the selection with it — which is exactly what the circulated
    // iOS recipe does, one line before the copy it is trying to enable.
    const fallback = clipboardFallback()
    const install = 'selection.addRange(range)'
    const start = fallback.indexOf(install)
    expect(start).toBeGreaterThan(-1)
    const copy = fallback.indexOf('return copyThroughEvent(text)', start)
    expect(copy).toBeGreaterThan(start)
    expect(fallback.slice(start + install.length, copy).trim()).toBe('')
  })

  it('never hides a carrier in a way that takes its renderer away', () => {
    // `opacity: 0`, `visibility: hidden` and `display: none` each leave text
    // with no renderer, and text with no renderer has nothing to select. The
    // carrier is clipped to 1x1 instead.
    const fallback = clipboardFallback()
    expect(fallback).toContain("style.overflow = 'hidden'")
    // Both ways of setting a property, because this file already uses
    // `setProperty` for `user-select` — matching only the dotted form would
    // leave the shape that is actually in front of the next author unguarded.
    expect(fallback).not.toMatch(/style\.(opacity|visibility|display)\s*=/)
    expect(fallback).not.toMatch(/setProperty\(\s*'(opacity|visibility|display)'/)
  })
})

const app = read('App.tsx')

/** The chrome header in RemoteTerminal.tsx, up to its closing tag. */
function headerSource(): string {
  const start = source.indexOf('<header className="terminal-header">')
  if (start < 0) throw new Error('self-check: terminal-header is gone')
  const end = source.indexOf('</header>', start)
  if (end < 0) throw new Error('self-check: terminal-header is unclosed')
  return source.slice(start, end)
}

describe('the phone header stays one row', () => {
  it('keeps the title on the line so the stage is the terminal', () => {
    expect(block(css, '.terminal-header {')).toContain('flex-wrap: nowrap')
    expect(css).not.toMatch(/@media \(max-width: 420px\)[\s\S]*flex-wrap:\s*wrap/)
  })
})

describe('the header is back, title, status and one overflow menu', () => {
  it('finds the header it is about to police', () => {
    const header = headerSource()
    expect(header).toContain('className="back"')
    expect(header).toContain('className="terminal-title"')
    expect(header).toContain('aria-expanded={menuOpen}')
    expect(header).toContain('aria-controls="header-menu-list"')
  })

  it('does not put search, copy, font or keys on the header row', () => {
    const header = headerSource()
    const menuStart = header.indexOf('className="header-menu-list"')
    expect(menuStart, 'self-check: the overflow menu is in the header').toBeGreaterThan(-1)
    const beforeMenu = header.slice(0, menuStart)
    expect(beforeMenu.match(/<button/g)).toHaveLength(2)
    expect(beforeMenu).not.toContain('keys-toggle')
    expect(beforeMenu).not.toContain('header-tools')
    expect(beforeMenu).not.toContain('font-btn')
  })

  it('keeps search, copy and the font pair inside the menu', () => {
    const header = headerSource()
    const menu = header.slice(header.indexOf('className="header-menu-list"'))
    expect(menu).toContain('copy.searchOpen')
    expect(menu).toContain('copy.copyBuffer')
    expect(menu).toContain('copy.fontSmaller')
    expect(menu).toContain('copy.fontLarger')
  })

  it('closes the menu on an outside tap and on Escape, without focusing it', () => {
    expect(source).toContain("addEventListener('pointerdown'")
    expect(source).toContain("event.key !== 'Escape'")
    expect(source).toContain('setMenuOpen(false)')
    expect(source).not.toMatch(/menuRef\.current\?\.focus/)
  })

  it('gives the title a floor so the name is not ellipsised into nothing', () => {
    const title = block(css, '.terminal-title {')
    expect(title).toContain('min-width: 8rem')
    expect(title).not.toContain('min-width: 0')
  })
})

describe('the input bar stays on compact chrome', () => {
  it('finds the bar it is about to police', () => {
    expect(css).toContain('.input-bar {')
    expect(css).toContain('.terminal-bar {')
    expect(source).toContain('className="input-bar terminal-bar"')
    expect(source).toContain('keys-toggle')
  })

  it('applies no is-compact class and hides no input-bar', () => {
    expect(source).not.toContain('is-compact')
    expect(css).not.toContain('is-compact')
    expect(block(css, '.terminal-bar {')).toContain('env(safe-area-inset-bottom)')
    expect(block(css, '.terminal-bar {')).toContain('min-height: var(--touch)')
  })

  it('puts the keys toggle in the bar, not the header', () => {
    const header = headerSource()
    expect(header).not.toContain('keys-toggle')
    const form = source.slice(source.indexOf('className="input-bar terminal-bar"'))
    expect(form).toContain('keys-toggle')
  })
})

describe('a tap on an agent row is visible', () => {
  it('finds the press state it is about to police', () => {
    expect(sheets['overview.css']).toContain('.agent-row:active')
    expect(sheets['overview.css']).toContain('.agent-row {')
  })

  it('flashes like a primary press and keeps the tap highlight', () => {
    expect(block(sheets['overview.css'], '.agent-row:active')).toContain('transform:')
    expect(block(sheets['overview.css'], '.agent-row {')).toContain('-webkit-tap-highlight-color')
  })
})

describe('opening a terminal is a named pending screen', () => {
  it('finds the fallback it is about to police', () => {
    expect(app).toContain('className="terminal-pending"')
    expect(app).toContain('<TerminalPending')
  })

  it('shows the agent name and the connecting copy, not a blank box', () => {
    expect(app).toContain('copy.terminalConnecting')
    expect(app).toContain('className="terminal-pending-title"')
    expect(app).not.toMatch(/fallback=\{<div className="terminal-pending"[^/]*\/>\}/)
  })
})
