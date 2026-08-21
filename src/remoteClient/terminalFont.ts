/**
 * The terminal's font size and where it is remembered. A phone user picks a
 * readable size once — outdoors, at arm's length — and must not have to pick
 * it again on the next visit, so it survives in `localStorage` under its own
 * key.
 *
 * Every storage access is guarded: Safari's private mode throws on the very
 * property access, and a bookmarked page with site data disabled must degrade
 * to the default rather than to a blank screen.
 */

/** Below 11 px the monospace grid stops being legible on a phone at all. */
export const FONT_MIN = 11

/** Above 24 px an 80-column line no longer fits any phone in portrait. */
export const FONT_MAX = 24

export const FONT_DEFAULT = 14

export const FONT_STORAGE_KEY = 'vertragus.remote.terminalFont'

/** The slice of `Storage` this module uses — the tests pass a fake. */
export type FontStore = Pick<Storage, 'getItem' | 'setItem'>

/** Snap to a whole, legible size; anything unusable falls back to the default. */
export function clampFontSize(size: number): number {
  if (!Number.isFinite(size)) return FONT_DEFAULT
  return Math.min(FONT_MAX, Math.max(FONT_MIN, Math.round(size)))
}

export function readFontSize(store: FontStore | undefined): number {
  if (!store) return FONT_DEFAULT
  try {
    const stored = store.getItem(FONT_STORAGE_KEY)
    if (stored === null) return FONT_DEFAULT
    const parsed = Number.parseInt(stored, 10)
    return Number.isNaN(parsed) ? FONT_DEFAULT : clampFontSize(parsed)
  } catch {
    return FONT_DEFAULT
  }
}

export function writeFontSize(store: FontStore | undefined, size: number): void {
  if (!store) return
  try {
    store.setItem(FONT_STORAGE_KEY, String(clampFontSize(size)))
  } catch {
    /* A full or disabled quota is not worth losing the terminal over. */
  }
}

/** `window.localStorage`, or nothing where reaching for it throws. */
export function localFontStore(): FontStore | undefined {
  try {
    return typeof window === 'undefined' ? undefined : window.localStorage
  } catch {
    return undefined
  }
}
