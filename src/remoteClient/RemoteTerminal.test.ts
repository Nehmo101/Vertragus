/**
 * Guard test for the invariants that live in `RemoteTerminal.tsx` itself.
 *
 * There is no DOM runner in this project, so the component cannot be rendered.
 * Everything it *decides* has been pushed into pure modules that are tested
 * next to it — `terminalScroll`, `terminalAttach`, `terminalResize`,
 * `terminalBuffer`, `terminalFont`. What is left in the component is a handful
 * of rules about how those decisions are wired up, and until now each one was
 * stated in a comment. A comment is not a guard: this file reads the source and
 * fails if a rule stops holding, which is the same instrument `i18n.test.ts`
 * and `docsTwins.test.ts` use for their cross-cutting rules.
 *
 * Every assertion below is paired with a self-check on its own scanning, so a
 * regex that quietly stops matching fails loudly instead of passing vacuously.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const source = readFileSync(fileURLToPath(new URL('./RemoteTerminal.tsx', import.meta.url)), 'utf8')

/** The dependency array closing the effect that builds the `Terminal`. */
function terminalEffectDeps(): string[] {
  const start = source.indexOf('new Terminal(')
  if (start < 0) throw new Error('self-check: the terminal effect no longer builds a Terminal')
  const close = source.indexOf('\n  }, [', start)
  if (close < 0) throw new Error('self-check: the terminal effect no longer ends in a dep array')
  const end = source.indexOf('])', close)
  if (end < 0) throw new Error('self-check: the dep array is not closed')
  return source
    .slice(close + '\n  }, ['.length, end)
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '')
}

/**
 * The body of the animation frame the coalesced fit runs in — everything
 * between opening the frame and closing its callback.
 */
function fitFrameBody(): string {
  const open = 'fitFrameRef.current = window.requestAnimationFrame(() => {'
  const start = source.indexOf(open)
  if (start < 0) throw new Error('self-check: the coalesced fit no longer opens a frame')
  const end = source.indexOf('\n    })', start)
  if (end < 0) throw new Error('self-check: the fit frame callback is not closed')
  return source.slice(start + open.length, end)
}

describe('the terminal is built once per agent', () => {
  it('finds a dependency array to check at all', () => {
    // Self-check for every assertion below: the scan above has to be pointing
    // at something before its verdict on that something means anything.
    expect(terminalEffectDeps().length).toBeGreaterThan(0)
  })

  it('keeps everything that re-renders out of the effect deps', () => {
    // `useRemote()` returns a fresh object every render, so an `api` dep is an
    // effect that re-runs on every workspace push — which rebuilds the
    // terminal, throws away the scrollback and drops the reader at the bottom.
    // That was the original bug; `exhaustive-deps` does not report a
    // *superfluous* dependency in v7 of the plugin, so this does.
    const deps = terminalEffectDeps()
    expect(deps).not.toContain('api')
    expect(deps).not.toContain('copy')
    expect(deps).not.toContain('fontSize')
    expect(deps).not.toContain('following')
  })

  it('depends on the agent and on stable callbacks only', () => {
    expect(terminalEffectDeps()).toEqual(['agentId', 'requestFit'])
  })
})

describe('the touch stream is taken from xterm, not shared with it', () => {
  const touchRegistrations = [...source.matchAll(/host\.addEventListener\('(touch\w+)',[^)]*\)/g)]

  it('registers the four touch events it claims to', () => {
    // Self-check plus the rule: all four, and nothing registered twice.
    const events = touchRegistrations.map((match) => match[1])
    expect([...events].sort()).toEqual(['touchcancel', 'touchend', 'touchmove', 'touchstart'])
  })

  it('registers every one of them in the capture phase', () => {
    // xterm binds its own touchstart/touchmove to `.xterm`, inside the host.
    // On the bubble phase ours run second, on a viewport xterm has already
    // moved by a raw pixel delta and then re-derived ydisp from absolutely.
    for (const registration of touchRegistrations) {
      expect(registration[0]).toContain('capture: true')
    }
  })

  it('stops the two events xterm listens for from reaching it', () => {
    for (const handler of ['onTouchStart', 'onTouchMove']) {
      const start = source.indexOf(`const ${handler} = (event: TouchEvent): void => {`)
      expect(start).toBeGreaterThan(-1)
      const body = source.slice(start, source.indexOf('\n    }\n', start))
      expect(body).toContain('event.stopPropagation()')
    }
  })

  it('drives a pixel position xterm cannot snap back, not whole lines', () => {
    // xterm rounds scrollTop onto ydisp and snaps the DOM back to a whole
    // row on the next frame. Writing scrollTop 1:1 then reading it back is
    // how a slow drag still died. The finger owns `desiredTop`, paints a
    // line-aligned scrollTop, and shifts `.xterm-screen` by the remainder.
    const start = source.indexOf('const onTouchMove = (event: TouchEvent): void => {')
    expect(start).toBeGreaterThan(-1)
    const body = source.slice(start, source.indexOf('\n    }\n', start))
    expect(body).toContain('applyFingerDelta(')
    expect(body).toContain('paintScroll(')
    expect(body).toContain('readTop()')
    expect(body).toContain('if (event.cancelable) event.preventDefault()')
    expect(body).not.toMatch(/max <= 0 \|\| !event\.cancelable/)
    expect(source).toContain('overscanRowCount(')
    expect(body).not.toContain('scrollLines')
    expect(body).not.toContain('linesFromPixels')
    expect(source).toContain('splitScrollPx(')
    expect(source).toContain('subrowTransform(')
    expect(source).toContain("querySelector('.xterm-screen')")
  })

  it('applies the slop once the drag commits instead of discarding it', () => {
    const start = source.indexOf('const onTouchMove = (event: TouchEvent): void => {')
    expect(start).toBeGreaterThan(-1)
    const body = source.slice(start, source.indexOf('\n    }\n', start))
    expect(body).toContain('committedFingerDelta(')
    expect(body).toContain('drag.origin')
    expect(body).toContain('drag.applied')
    // The discarded-slop shape: bail on `!isDrag` after consuming the delta
    // into `last`, so the first committed move is only the current pixel.
    expect(body).not.toMatch(/if \(!isDrag\(drag\.travel\)\) return/)
    const init = source.indexOf('drag = {')
    expect(init).toBeGreaterThan(-1)
    const initBody = source.slice(init, source.indexOf('}', source.indexOf('samples:', init)))
    expect(initBody).toContain('origin: touch.clientY')
    expect(initBody).toContain('applied: null')
  })

  it('takes the wheel on the same pixel path so a laptop trackpad pans', () => {
    const start = source.indexOf('const onWheel = (event: WheelEvent): void => {')
    expect(start).toBeGreaterThan(-1)
    const body = source.slice(start, source.indexOf('\n    }\n', start))
    expect(body).toContain('applyWheelDelta(')
    expect(body).toContain('wheelDeltaPx(')
    expect(body).toContain('readTop()')
    expect(body).toContain('paintScroll(')
    expect(source).toContain("host.addEventListener('wheel', onWheel, { capture: true, passive: false })")
  })

  it('stops a ctrl-wheel reaching xterm so the browser can still zoom', () => {
    const start = source.indexOf('const onWheel = (event: WheelEvent): void => {')
    expect(start).toBeGreaterThan(-1)
    const body = source.slice(start, source.indexOf('\n    }\n', start))
    expect(body).toContain('if (event.ctrlKey)')
    expect(body).toContain('event.stopPropagation()')
    // The ctrl branch must not cancel the default — that is the zoom.
    const ctrl = body.slice(body.indexOf('if (event.ctrlKey)'), body.indexOf('const port'))
    expect(ctrl).toContain('event.stopPropagation()')
    expect(ctrl).not.toContain('event.preventDefault()')
  })
})

describe('a re-attach continues the terminal instead of rebuilding it', () => {
  it('resets only on the plan that earned it', () => {
    // A phone reconnects routinely — liveness probe, visibilitychange,
    // pageshow, online — and every reconnect brings a fresh snapshot. An
    // unconditional reset throws away xterm's local buffer, the alternate
    // screen and the reader's place, all to replay a host buffer that is
    // capped in characters and trimmed from the head.
    const resets = [...source.matchAll(/term\.reset\(\)/g)]
    expect(resets).toHaveLength(1)
    expect(source).toContain("if (plan.kind === 'replay') {\n          term.reset()")
  })

  it('routes the snapshot through the attach plan', () => {
    expect(source).toContain('planAttach({ snapshot, written })')
    expect(source).toContain('attachScroll(plan, followRef.current)')
  })
})

describe('a resize is a decision, not a side effect of every fit', () => {
  it('asks the host for a size in exactly one place, and only through the rule', () => {
    // The PTY is shared with the desktop window: a resize repaints the agent's
    // TUI there too, which is why a keyboard-shrunk viewport and an A+/A− tap
    // must not produce one.
    const calls = [...source.matchAll(/apiRef\.current\.resize\(/g)]
    expect(calls).toHaveLength(1)
    expect(source).toContain('const size = hostResize({')
    expect(source).toContain('if (size) {')
  })

  it('asks whether the view is laid out rather than catching a throw', () => {
    // `FitAddon.fit()` returns silently when it cannot propose dimensions, so
    // a try/catch around it guards nothing while xterm's 80x24 goes to the host.
    //
    // The negative here is about the code, not about a comment somebody may
    // once have written next to it: it scans the body that does the fitting and
    // requires that there be no exception handling anywhere in it. The two
    // assertions before it are its self-check — the scan has to be pointing at
    // the fit before its verdict on the fit means anything.
    const body = fitFrameBody()
    expect(body).toContain('fit.proposeDimensions()')
    expect(body).toContain('fit.fit()')
    expect(body).toContain('overscanRowCount(')
    // Matched as syntax, not as prose: the comment two lines above the fit in
    // that body says the words "try/catch" and is the reason they are wrong.
    expect(body).not.toMatch(/\btry\s*\{|\bcatch\s*[({]/)
  })
})

describe('a software keyboard reshapes this phone, never the shared PTY', () => {
  it('keeps the on-screen keyboard off the hidden textarea xterm types into', () => {
    // The whole reason a tap on the output does not halve the viewport. It is
    // an attribute, set on an element this component does not own, that no
    // type checker and no other test looks at.
    const guard = "if (isCoarsePointer()) term.textarea?.setAttribute('inputmode', 'none')"
    expect(source).toContain(guard)
    // Self-check on the scan above: the two halves of that line, found
    // independently, so a reformat fails here as a reformat and not as a
    // missing rule.
    expect(source).toContain("setAttribute('inputmode', 'none')")
    expect(source).toContain('isCoarsePointer()')
  })

  it('measures the viewport rather than trusting the fields of this view', () => {
    // WebKit honours `inputmode` only from Safari 16.4. On an older iOS the
    // keyboard still comes up, and it comes up with xterm's own textarea
    // focused — so neither `composing` nor `searchOpen` is true, the ~12-row
    // fit clears MIN_HOST_ROWS, and the desktop's TUI repaints. The
    // measurement is the half of the rule that covers that route.
    //
    // Both halves are stated as positives on purpose. A negative against the
    // old `transient: transientRef.current` could never be the assertion that
    // failed — the positive above it goes first for the same edit — and an
    // assertion that cannot be the one to fail is not coverage.
    const body = fitFrameBody()
    expect(body).toContain('transient: isTransientViewport({')
    expect(body).toContain('displacement: viewportDisplacement()')
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

describe('JS owns the one-finger pan', () => {
  const css = readFileSync(fileURLToPath(new URL('./terminal.css', import.meta.url)), 'utf8')

  function block(selector: string): string {
    const start = css.indexOf(selector)
    if (start < 0) throw new Error(`self-check: ${selector} is gone`)
    const open = css.indexOf('{', start)
    const close = css.indexOf('\n}', open)
    if (open < 0 || close < 0) throw new Error(`self-check: ${selector} is not a block`)
    return css.slice(open, close)
  }

  it('finds the three layers that would grant a native pan', () => {
    expect(block('.terminal-stage {').length).toBeGreaterThan(0)
    expect(block('\n.terminal-host {').length).toBeGreaterThan(0)
    expect(block('.terminal-host .xterm-viewport {').length).toBeGreaterThan(0)
  })

  it('does not grant pan-y on the stage, host or viewport', () => {
    // pan-y tells Safari it may start a native pan before JS preventDefault
    // can run. This overlay's drag writes scrollTop; two owners is the 3/10.
    for (const selector of ['.terminal-stage {', '\n.terminal-host {', '.terminal-host .xterm-viewport {']) {
      expect(block(selector), selector).toContain('touch-action: pinch-zoom')
      expect(block(selector), selector).not.toMatch(/touch-action:[^;]*pan-y/)
    }
  })

  it('keeps the phone header on one row so the stage is the terminal', () => {
    expect(block('.terminal-header').length).toBeGreaterThan(0)
    expect(block('.terminal-header')).toContain('flex-wrap: nowrap')
    expect(css).not.toMatch(/@media \(max-width: 420px\)[\s\S]*flex-wrap:\s*wrap/)
  })
})
