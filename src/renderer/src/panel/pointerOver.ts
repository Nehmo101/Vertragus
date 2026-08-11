/**
 * "Is the mouse over the panel?" as a class on the root element.
 *
 * The panel drags on its whole surface, and on Windows a drag region is OS
 * chrome: Chromium never sees a mouse event there, so `.panel:hover` is only
 * true over the no-drag islands (the buttons) — which is exactly why the
 * sidebar used to light up over the orchestrator's name and nowhere else. The
 * main process therefore measures the cursor against the window bounds and
 * pushes the answer here; see `main/windows/panelHover.ts`.
 *
 * Kept out of the component and free of DOM types so it can be unit-tested in
 * plain Node — the same shape as `terminal/windowFocus.ts`.
 */

/** The root element's class list, as much of it as this module needs. */
export interface PointerClassTarget {
  add(token: string): void
  remove(token: string): void
}

/** The preload bridge, as much of it as this module needs. */
export interface PointerEventSource {
  onPointer(listener: (event: { inside: boolean }) => void): () => void
}

export const POINTER_OVER_CLASS = 'is-pointer-over'

/**
 * Mirror the main process' pointer state onto `target` until the returned
 * function is called. The cleanup also drops the class, so a React strict-mode
 * double mount cannot leave a stale one behind.
 */
export function trackPanelPointer(
  target: PointerClassTarget,
  source: PointerEventSource,
  className: string = POINTER_OVER_CLASS
): () => void {
  const off = source.onPointer(({ inside }) => {
    if (inside) target.add(className)
    else target.remove(className)
  })
  return () => {
    off()
    target.remove(className)
  }
}
