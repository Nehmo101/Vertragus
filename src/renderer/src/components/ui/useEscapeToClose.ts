import { useEffect, useRef } from 'react'

/**
 * Keydown listener factory — the pure core of the hook, exported so the node
 * test environment can exercise it without a DOM.
 */
export function createEscapeKeydownHandler(
  onClose: () => void
): (event: Pick<KeyboardEvent, 'key'>) => void {
  return (event) => {
    if (event.key === 'Escape') onClose()
  }
}

/**
 * Central Escape-to-close handler, shared by the Modal primitive and by
 * non-modal popovers (e.g. the GitWorkspaceTree branch popover).
 *
 * Registers a single window keydown listener while `enabled` is true and
 * always calls the latest `onClose`, so callers may pass inline closures
 * without re-registering the listener on every render.
 */
export function useEscapeToClose(
  onClose: () => void,
  options: { enabled?: boolean } = {}
): void {
  const enabled = options.enabled ?? true
  const onCloseRef = useRef(onClose)
  useEffect(() => {
    onCloseRef.current = onClose
  })
  useEffect(() => {
    if (!enabled) return
    const onKeyDown = createEscapeKeydownHandler(() => onCloseRef.current())
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [enabled])
}
