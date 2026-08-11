/**
 * "Is this window the one being typed in?" as a class on the root element.
 *
 * Vertragus windows are ghosts at rest and near-solid on hover, which is right
 * for reading and wrong for working: at 0.97 opacity over a colourful desktop,
 * terminal text still shimmers. OS focus is the honest signal for "the user is
 * working in here", so CSS gets it as `is-window-focused` and turns the glass
 * fully solid for that one window.
 *
 * Kept out of the component and free of DOM types so it can be unit-tested in
 * plain Node: everything it touches is a two-method structural type.
 */

/** The root element's class list, as much of it as this module needs. */
export interface FocusClassTarget {
  add(token: string): void
  remove(token: string): void
}

/** The window, as much of it as this module needs. */
export interface FocusEventSource {
  addEventListener(type: string, listener: () => void): void
  removeEventListener(type: string, listener: () => void): void
  /** Initial state: a window can already be focused when the bundle loads. */
  hasFocus?: () => boolean
}

export const WINDOW_FOCUSED_CLASS = 'is-window-focused'

/**
 * Mirror the window's focus state onto `target` until the returned function is
 * called. Returns a cleanup that also drops the class, so a React strict-mode
 * double mount cannot leave a stale one behind.
 */
export function trackWindowFocus(
  target: FocusClassTarget,
  source: FocusEventSource,
  className: string = WINDOW_FOCUSED_CLASS
): () => void {
  const onFocus = (): void => target.add(className)
  const onBlur = (): void => target.remove(className)

  if (source.hasFocus?.() ?? false) onFocus()
  else onBlur()

  source.addEventListener('focus', onFocus)
  source.addEventListener('blur', onBlur)

  return () => {
    source.removeEventListener('focus', onFocus)
    source.removeEventListener('blur', onBlur)
    target.remove(className)
  }
}
