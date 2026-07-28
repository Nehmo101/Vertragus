import { describe, expect, it, vi } from 'vitest'
import {
  FOCUSABLE_SELECTOR,
  firstFocusable,
  trapTabKey,
  type TrapContainer,
  type TrapElement
} from './focusTrap'

interface FakeElement extends TrapElement {
  name: string
  focused: boolean
}

function fakeElement(name: string): FakeElement {
  const el: FakeElement = {
    name,
    focused: false,
    focus() {
      el.focused = true
    }
  }
  return el
}

function fakeContainer(children: FakeElement[]): TrapContainer & { focused: boolean } {
  const container = {
    focused: false,
    focus() {
      container.focused = true
    },
    querySelectorAll(selectors: string): FakeElement[] {
      expect(selectors).toBe(FOCUSABLE_SELECTOR)
      return children
    },
    contains(other: Node | null): boolean {
      return other === (container as unknown) || children.includes(other as unknown as FakeElement)
    }
  }
  return container
}

function tab(shift = false): { key: string; shiftKey: boolean; preventDefault: () => void } {
  return { key: 'Tab', shiftKey: shift, preventDefault: vi.fn() }
}

describe('trapTabKey', () => {
  it('ignores non-Tab keys', () => {
    const container = fakeContainer([fakeElement('a')])
    const event = { key: 'Enter', shiftKey: false, preventDefault: vi.fn() }

    expect(trapTabKey(event, container, null)).toBeNull()
    expect(event.preventDefault).not.toHaveBeenCalled()
  })

  it('lets Tab pass through in the middle of the cycle', () => {
    const [a, b, c] = [fakeElement('a'), fakeElement('b'), fakeElement('c')]
    const container = fakeContainer([a, b, c])
    const event = tab()

    expect(trapTabKey(event, container, b)).toBeNull()
    expect(event.preventDefault).not.toHaveBeenCalled()
  })

  it('wraps Tab from the last element to the first', () => {
    const [a, b] = [fakeElement('a'), fakeElement('b')]
    const container = fakeContainer([a, b])
    const event = tab()

    expect(trapTabKey(event, container, b)).toBe(a)
    expect(a.focused).toBe(true)
    expect(event.preventDefault).toHaveBeenCalled()
  })

  it('wraps Shift+Tab from the first element to the last', () => {
    const [a, b] = [fakeElement('a'), fakeElement('b')]
    const container = fakeContainer([a, b])
    const event = tab(true)

    expect(trapTabKey(event, container, a)).toBe(b)
    expect(b.focused).toBe(true)
    expect(event.preventDefault).toHaveBeenCalled()
  })

  it('pulls escaped focus back to the first element', () => {
    const [a, b] = [fakeElement('a'), fakeElement('b')]
    const container = fakeContainer([a, b])
    const outside = fakeElement('outside')
    const event = tab()

    expect(trapTabKey(event, container, outside)).toBe(a)
    expect(a.focused).toBe(true)
  })

  it('parks focus on the dialog when nothing is tabbable', () => {
    const container = fakeContainer([])
    const event = tab()

    expect(trapTabKey(event, container, null)).toBe(container)
    expect(container.focused).toBe(true)
    expect(event.preventDefault).toHaveBeenCalled()
  })
})

describe('firstFocusable', () => {
  it('returns the first tabbable element', () => {
    const [a, b] = [fakeElement('a'), fakeElement('b')]
    expect(firstFocusable(fakeContainer([a, b]))).toBe(a)
  })

  it('returns undefined for an empty container', () => {
    expect(firstFocusable(fakeContainer([]))).toBeUndefined()
  })
})
