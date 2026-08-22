/**
 * A local override for the appearance the desktop dictates.
 *
 * The gateway sends `hello.theme`, and following it is the right default: the
 * phone is a remote control for that desktop. It is the wrong *master*, and
 * only on the phone — the desktop sits indoors under a lamp, the phone is
 * held outdoors in sunlight where the dark sheet is unreadable, and the person
 * holding it cannot walk over and flip the desktop's setting. So the
 * preference is local to the device, persisted, and composes with the host's:
 * 'host' keeps following, 'dark'/'light' pin it.
 */
import { readStored, writeStored, type StorageLike } from './navState'

export type ThemePreference = 'host' | 'dark' | 'light'
export type Theme = 'dark' | 'light'

export const THEME_KEY = 'vertragus.remote.theme'

const PREFERENCES: readonly ThemePreference[] = ['host', 'dark', 'light']

/**
 * The document background per theme, mirroring `--bg` in `styles.css`. Only a
 * fallback: `themeColorFrom` prefers the computed token so the two cannot
 * drift, and reaches for these literals only if the sheet has not applied yet
 * — which is exactly the first paint the `theme-color` meta exists for.
 */
const FALLBACK_BG: Record<Theme, string> = { dark: '#0e1013', light: '#f4f1ea' }

export function parseThemePreference(raw: string | undefined): ThemePreference {
  return PREFERENCES.includes(raw as ThemePreference) ? (raw as ThemePreference) : 'host'
}

export function readThemePreference(storage?: StorageLike): ThemePreference {
  return parseThemePreference(readStored(THEME_KEY, storage))
}

export function writeThemePreference(preference: ThemePreference, storage?: StorageLike): void {
  writeStored(THEME_KEY, preference, storage)
}

export function resolveTheme(preference: ThemePreference, hostTheme: Theme): Theme {
  return preference === 'host' ? hostTheme : preference
}

/** One control, three states: follow → dark → light → follow. */
export function nextThemePreference(preference: ThemePreference): ThemePreference {
  return PREFERENCES[(PREFERENCES.indexOf(preference) + 1) % PREFERENCES.length]!
}

export function themePreferenceLabel(
  preference: ThemePreference,
  copy: { themeFollowHost: string; themeDark: string; themeLight: string }
): string {
  if (preference === 'dark') return copy.themeDark
  if (preference === 'light') return copy.themeLight
  return copy.themeFollowHost
}

/** Icons, not copy — they carry no language, like the `⟳` in the header. */
const GLYPHS: Record<ThemePreference, string> = { host: '◐', dark: '☾', light: '☀' }

export function themeGlyph(preference: ThemePreference): string {
  return GLYPHS[preference]
}

/**
 * The colour the browser paints its chrome with. Consumes the `--bg` token
 * rather than restating it, so the status bar can never disagree with the
 * page it sits above.
 */
export function themeColorFrom(computed: string | undefined, theme: Theme): string {
  const value = computed?.trim()
  return value || FALLBACK_BG[theme]
}
