/**
 * Focus-trap helpers for the Modal primitive.
 *
 * The Tab-cycling logic is kept free of React and typed against minimal
 * element shapes (which real HTMLElements satisfy), so it can be unit-tested
 * in the node test environment with small fake elements.
 */

export const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])'
].join(', ')

/** Minimal focusable element shape. */
export interface TrapElement {
  focus(): void
}

/** Minimal dialog-container shape. */
export interface TrapContainer extends TrapElement {
  querySelectorAll(selectors: string): ArrayLike<TrapElement>
  contains(other: Node | null): boolean
}

/** Minimal keyboard event shape. */
export interface TrapKeyEvent {
  key: string
  shiftKey: boolean
  preventDefault(): void
}

/**
 * Keeps Tab / Shift+Tab cycling inside `container`.
 *
 * Returns the element that received focus, or null when the browser default
 * was left alone (non-Tab keys, or a Tab that stays inside the dialog).
 */
export function trapTabKey(
  event: TrapKeyEvent,
  container: TrapContainer,
  active: unknown
): TrapElement | null {
  if (event.key !== 'Tab') return null

  const focusables = Array.from(container.querySelectorAll(FOCUSABLE_SELECTOR))
  if (focusables.length === 0) {
    // Nothing tabbable — park focus on the dialog itself.
    event.preventDefault()
    container.focus()
    return container
  }

  const first = focusables[0]
  const last = focusables[focusables.length - 1]

  if (!container.contains(active as Node | null)) {
    // Focus escaped (or never entered) — pull it back in.
    event.preventDefault()
    const target = event.shiftKey ? last : first
    target.focus()
    return target
  }

  const index = focusables.indexOf(active as TrapElement)
  if (event.shiftKey && index <= 0) {
    // Shift+Tab from the first element (or the dialog itself) wraps to the end.
    event.preventDefault()
    last.focus()
    return last
  }
  if (!event.shiftKey && index === focusables.length - 1) {
    event.preventDefault()
    first.focus()
    return first
  }
  return null
}

/** First tabbable element inside the container, if any. */
export function firstFocusable(container: TrapContainer): TrapElement | undefined {
  const focusables = container.querySelectorAll(FOCUSABLE_SELECTOR)
  return focusables.length > 0 ? focusables[0] : undefined
}
