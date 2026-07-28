import { useEffect, useState } from 'react'

/**
 * Reaktiver `window.location.hash` für das Hash-Routing der App
 * ('' = Workspace, '#/inbox', '#/approvals', '#/changes', …).
 *
 * Einzige gemeinsame Implementierung — App.tsx nutzt sie bereits; die noch
 * vorhandene Dublette in Sidebar.tsx kann durch einen Import dieses Hooks
 * ersetzt werden.
 */
export function useHashRoute(): string {
  const [hash, setHash] = useState(() => window.location.hash)
  useEffect(() => {
    const onChange = (): void => setHash(window.location.hash)
    window.addEventListener('hashchange', onChange)
    return () => window.removeEventListener('hashchange', onChange)
  }, [])
  return hash
}
