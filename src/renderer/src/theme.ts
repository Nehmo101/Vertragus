/**
 * Renderer theme — `data-theme` on the document root, driven by `ui.theme`.
 *
 * Mirrors {@link followStoredLocale}: app windows read the setting before the
 * first paint and then follow `ev:settings`. CLI and zone windows cannot call
 * `settings:get`; they adopt the theme from their attach/load payload and still
 * follow the broadcast once main includes them as targets.
 *
 * The xterm palette stays dark on purpose (see `terminal/xtermTheme.ts`); only
 * the chrome around it uses these tokens.
 */
import type { PanelSettings } from '../../preload'

export type Theme = 'dark' | 'light'

/** Matches `uiSettingsSchema`'s default in the main store. */
export const DEFAULT_THEME: Theme = 'dark'

const THEME_ATTR = 'data-theme'

export function isTheme(value: unknown): value is Theme {
  return value === 'dark' || value === 'light'
}

/** Apply a theme to THIS window's document. Unknown values are ignored. */
export function applyTheme(theme: unknown, root: HTMLElement = document.documentElement): void {
  if (!isTheme(theme)) return
  if (root.getAttribute(THEME_ATTR) === theme) return
  root.setAttribute(THEME_ATTR, theme)
}

/** Nothing may hold the first paint hostage; see {@link followStoredTheme}. */
export const THEME_BOOT_TIMEOUT_MS = 1_500

/**
 * Wire this window to the stored appearance.
 *
 * Same two-half contract as locale: await a bounded first read, then subscribe
 * to `ev:settings` for the life of the window. A rejected read (CLI window) or
 * a missing bridge leaves the default dark theme in place until a payload or
 * broadcast supplies the real value.
 *
 * Resolves to the unsubscribe.
 */
export async function followStoredTheme(): Promise<() => void> {
  const bridge = window.vertragus?.app
  if (!bridge) {
    applyTheme(DEFAULT_THEME)
    return () => undefined
  }

  const firstRead = bridge
    .getSettings()
    .then((settings: PanelSettings) => applyTheme(settings.theme))
    .catch(() => undefined)
  await Promise.race([
    firstRead,
    new Promise((resolve) => setTimeout(resolve, THEME_BOOT_TIMEOUT_MS))
  ])

  // Ensure the attribute is set even when the read timed out or failed.
  if (!document.documentElement.hasAttribute(THEME_ATTR)) applyTheme(DEFAULT_THEME)

  return bridge.onSettings((settings) => applyTheme(settings.theme))
}
