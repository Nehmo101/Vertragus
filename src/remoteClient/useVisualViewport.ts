/**
 * Keep the layout glued to the *visible* viewport. On a phone the software
 * keyboard shrinks visualViewport; 100% / 100dvh still includes the hidden
 * half, so the composer and the terminal input bar sit under the keys.
 */
import { useEffect } from 'react'

export function useVisualViewport(): void {
  useEffect(() => {
    const root = document.documentElement
    const apply = (): void => {
      const vv = window.visualViewport
      const height = vv?.height ?? window.innerHeight
      const offsetTop = vv?.offsetTop ?? 0
      const keyboard = Math.max(0, window.innerHeight - height - offsetTop)
      root.style.setProperty('--vv-height', `${Math.round(height)}px`)
      root.style.setProperty('--keyboard-inset', `${Math.round(keyboard)}px`)
    }
    apply()
    const vv = window.visualViewport
    vv?.addEventListener('resize', apply)
    vv?.addEventListener('scroll', apply)
    window.addEventListener('resize', apply)
    window.addEventListener('orientationchange', apply)
    return () => {
      vv?.removeEventListener('resize', apply)
      vv?.removeEventListener('scroll', apply)
      window.removeEventListener('resize', apply)
      window.removeEventListener('orientationchange', apply)
    }
  }, [])
}
