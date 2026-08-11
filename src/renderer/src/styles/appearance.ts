/**
 * Wire one window to the stored appearance.
 *
 * The mirror image of `i18n/followStoredLocale`, and for the same reason: the
 * value lives in the main process, every window needs it, and no window may
 * hold its first paint hostage waiting for it. Two halves —
 *
 * 1. one awaited read, bounded by {@link APPEARANCE_BOOT_TIMEOUT_MS}, so the
 *    window opens at the user's opacity instead of flashing the design default
 *    and correcting itself half a second later;
 * 2. then `ev:appearance` for as long as the window lives, which is what makes
 *    a slider in the settings window redraw the panel and every open terminal
 *    while it is being dragged.
 *
 * Unlike the locale, this one also works in a CLI window: appearance has its
 * own channel precisely because those windows are not app windows on the IPC
 * guard (see APP_CHANNELS.settingsAppearance).
 */
import {
  appearanceCssVars,
  normalizeAppearance,
  OPAQUE_ROOT_CLASS,
  type Appearance
} from '@shared/appearance'

/** Nothing may hold the first paint hostage; mirrors LOCALE_BOOT_TIMEOUT_MS. */
export const APPEARANCE_BOOT_TIMEOUT_MS = 1_500

/**
 * Paint one window at this appearance.
 *
 * Pure DOM writes against the element that carries them — the four variables
 * `tokens.css` is written against, plus the class that drops the now-pointless
 * backdrop blur. Exported for the settings window, which applies its own draft
 * locally while a slider is still moving instead of waiting for the round trip
 * through main.
 */
export function applyAppearance(root: HTMLElement, appearance: Appearance): void {
  const value = normalizeAppearance(appearance)
  for (const [name, cssValue] of Object.entries(appearanceCssVars(value))) {
    root.style.setProperty(name, cssValue)
  }
  root.classList.toggle(OPAQUE_ROOT_CLASS, !value.translucent)
}

/**
 * Read once, then follow. Resolves to the unsubscribe.
 *
 * A rejected read is not an error worth showing: the window simply keeps the
 * defaults `tokens.css` already declares, which is exactly what it looked like
 * before this setting existed.
 */
export async function followAppearance(
  root: HTMLElement = document.documentElement
): Promise<() => void> {
  const bridge = window.vertragus?.app
  if (!bridge) return () => undefined

  const firstRead = bridge
    .getAppearance()
    .then((appearance) => applyAppearance(root, appearance))
    .catch(() => undefined)
  await Promise.race([
    firstRead,
    new Promise((resolve) => setTimeout(resolve, APPEARANCE_BOOT_TIMEOUT_MS))
  ])

  return bridge.onAppearance((appearance) => applyAppearance(root, appearance))
}
