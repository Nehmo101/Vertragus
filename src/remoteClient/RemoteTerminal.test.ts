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
    expect(source).toContain('fit.proposeDimensions()')
    expect(source).not.toMatch(/catch\s*\{\s*\n\s*return \/\* The view is not laid out/)
  })
})
