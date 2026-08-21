/**
 * Renderer i18n — one bundle, one namespace, two languages.
 *
 * German is the authored source language and stays the boot default, so a
 * window that cannot read the setting (a CLI window is not an app window on the
 * IPC guard) looks exactly like it did before this pass. English is a full
 * translation, not a fallback with holes: `i18n.test.ts` fails the build when
 * the two key sets drift apart or when a `t('…')` literal has no key.
 *
 * There is deliberately no `strings.ts` layer left in the renderer. Components
 * call `useTranslation()` and pass `t` into the pure view/model functions that
 * need copy — those run in plain Node tests, so a hidden module-level singleton
 * inside them would be a language they could never switch.
 */
import i18n from 'i18next'
import type { TFunction } from 'i18next'
import { initReactI18next } from 'react-i18next'
import de from './locales/de.json'
import en from './locales/en.json'

export type Locale = 'de' | 'en'

/** Every language the app ships. Order is the order of the settings picker. */
export const LOCALES: readonly Locale[] = ['de', 'en']

/**
 * The authored language. Matches `uiSettingsSchema`'s default in the main
 * store, so a fresh install and a window without a settings bridge agree.
 */
export const DEFAULT_LOCALE: Locale = 'de'

export function isLocale(value: unknown): value is Locale {
  return value === 'de' || value === 'en'
}

/**
 * The translate function as the pure modules take it.
 *
 * Aliased rather than imported as `TFunction` everywhere so `viewModel.ts` and
 * the `model.ts` files depend on ONE renderer-owned name instead of on
 * i18next's generics.
 */
export type Translate = TFunction

void i18n.use(initReactI18next).init({
  resources: {
    de: { translation: de },
    en: { translation: en }
  },
  lng: DEFAULT_LOCALE,
  fallbackLng: DEFAULT_LOCALE,
  // React escapes for us; interpolating a profile name must not turn an
  // apostrophe into `&#39;` inside a `title` attribute.
  interpolation: { escapeValue: false },
  returnEmptyString: false
})

/** A `t` bound to one language — for tests and for non-React call sites. */
export function translator(locale: Locale): Translate {
  return i18n.getFixedT(locale)
}

/**
 * Narrow i18next's free-form `i18n.language` to a shipped locale. Components
 * pass the result into pure functions that pick bilingual data (the Commedia
 * blurbs) — the same threading discipline as `t`, so those functions stay
 * testable in plain Node without a hidden language singleton.
 */
export function activeLocale(language: string | undefined): Locale {
  return isLocale(language) ? language : DEFAULT_LOCALE
}

/** Switch the UI language of THIS window. Unknown values are ignored. */
export async function applyLocale(locale: unknown): Promise<void> {
  if (!isLocale(locale) || locale === i18n.language) return
  await i18n.changeLanguage(locale)
}

/** Nothing may hold the first paint hostage; see {@link followStoredLocale}. */
export const LOCALE_BOOT_TIMEOUT_MS = 1_500

/**
 * Wire this window to the stored language.
 *
 * Two halves, both best-effort. The first read is AWAITED so the window paints
 * once, in the right language, instead of flashing German and correcting
 * itself — but only for as long as {@link LOCALE_BOOT_TIMEOUT_MS}: a bridge
 * that never answers must cost a wrong label, never the whole surface. After
 * that the window follows `ev:settings` for as long as it lives.
 *
 * A rejected read is not an error worth showing. The panel, both editors and
 * the settings window may call `settings:get`; a CLI window may not, and it is
 * supposed to keep the default rather than display a bridge complaint.
 *
 * Resolves to the unsubscribe.
 */
export async function followStoredLocale(): Promise<() => void> {
  const bridge = window.vertragus?.app
  if (!bridge) return () => undefined

  const firstRead = bridge
    .getSettings()
    .then((settings) => applyLocale(settings.locale))
    .catch(() => undefined)
  await Promise.race([
    firstRead,
    new Promise((resolve) => setTimeout(resolve, LOCALE_BOOT_TIMEOUT_MS))
  ])

  return bridge.onSettings((settings) => void applyLocale(settings.locale))
}

export default i18n
