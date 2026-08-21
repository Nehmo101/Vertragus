import { describe, expect, it } from 'vitest'
import { shouldFocusTerminal, trackWindowFocus, WINDOW_FOCUSED_CLASS } from './windowFocus'

/** A classList and a window, small enough to assert on. */
function fakes(hasFocus: boolean): {
  classes: Set<string>
  listeners: Map<string, Set<() => void>>
  target: { add(token: string): void; remove(token: string): void }
  source: {
    addEventListener(type: string, listener: () => void): void
    removeEventListener(type: string, listener: () => void): void
    hasFocus(): boolean
  }
  fire(type: string): void
} {
  const classes = new Set<string>()
  const listeners = new Map<string, Set<() => void>>()
  return {
    classes,
    listeners,
    target: {
      add: (token) => void classes.add(token),
      remove: (token) => void classes.delete(token)
    },
    source: {
      addEventListener: (type, listener) => {
        const set = listeners.get(type) ?? new Set()
        set.add(listener)
        listeners.set(type, set)
      },
      removeEventListener: (type, listener) => {
        listeners.get(type)?.delete(listener)
      },
      hasFocus: () => hasFocus
    },
    fire: (type) => {
      for (const listener of listeners.get(type) ?? []) listener()
    }
  }
}

describe('trackWindowFocus', () => {
  it('reflects the focus the window already has when the bundle loads', () => {
    const { classes, target, source } = fakes(true)
    trackWindowFocus(target, source)
    expect(classes.has(WINDOW_FOCUSED_CLASS)).toBe(true)
  })

  it('starts unfocused when the window is not the active one', () => {
    const { classes, target, source } = fakes(false)
    trackWindowFocus(target, source)
    expect(classes.has(WINDOW_FOCUSED_CLASS)).toBe(false)
  })

  it('follows focus and blur', () => {
    const { classes, target, source, fire } = fakes(false)
    trackWindowFocus(target, source)

    fire('focus')
    expect(classes.has(WINDOW_FOCUSED_CLASS)).toBe(true)
    fire('blur')
    expect(classes.has(WINDOW_FOCUSED_CLASS)).toBe(false)
  })

  it('unsubscribes and drops the class on cleanup', () => {
    const { classes, listeners, target, source, fire } = fakes(true)
    const stop = trackWindowFocus(target, source)

    stop()
    expect(classes.has(WINDOW_FOCUSED_CLASS)).toBe(false)
    // A strict-mode remount must not leave a second pair of listeners behind.
    expect([...listeners.values()].every((set) => set.size === 0)).toBe(true)
    fire('focus')
    expect(classes.has(WINDOW_FOCUSED_CLASS)).toBe(false)
  })

  it('treats a source without hasFocus as unfocused rather than crashing', () => {
    const { classes, target, source, fire } = fakes(true)
    trackWindowFocus(target, {
      addEventListener: source.addEventListener,
      removeEventListener: source.removeEventListener
    })

    expect(classes.has(WINDOW_FOCUSED_CLASS)).toBe(false)
    fire('focus')
    expect(classes.has(WINDOW_FOCUSED_CLASS)).toBe(true)
  })
})

describe('shouldFocusTerminal', () => {
  it('focuses xterm only when the document already has OS focus', () => {
    expect(shouldFocusTerminal(true)).toBe(true)
    expect(shouldFocusTerminal(false)).toBe(false)
  })
})
