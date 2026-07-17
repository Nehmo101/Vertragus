import { useEffect, useState, type RefObject } from 'react'

/**
 * Portal container for fixed-position overlays: the closest `.app-root`, which
 * carries the design tokens and the data-theme attribute — a portal into
 * document.body would fall back to the pre-theme token defaults. Resolved in an
 * effect because render must not read refs; body is only the SSR-safe fallback.
 */
export function useAppRootPortalTarget(anchorRef: RefObject<Element>): Element | null {
  const [target, setTarget] = useState<Element | null>(null)
  useEffect(() => {
    setTarget(anchorRef.current?.closest('.app-root') ?? document.body)
  }, [anchorRef])
  return target
}
