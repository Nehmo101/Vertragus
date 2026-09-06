/**
 * When the terminal's chrome folds. Coarse pointers fold at any width; a
 * laptop window this narrow is a phone for layout purposes even if the
 * pointer is still fine — DevTools device mode is exactly that, and so is a
 * split laptop window.
 */
export const COMPACT_MAX_WIDTH_PX = 700

/** Should the reading chrome (open keys, the composer) fold away? */
export function isCompactChrome(input: { coarse: boolean; widthPx: number }): boolean {
  if (input.coarse) return true
  return Number.isFinite(input.widthPx) && input.widthPx <= COMPACT_MAX_WIDTH_PX
}
