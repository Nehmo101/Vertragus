/**
 * Renderer i18n: German is the authored source language, English the first
 * translation. The persisted preference lives in the main config store under
 * `ui.language` ('system' | 'de' | 'en'); 'system' follows the OS locale
 * with an English fallback. Screens migrate incrementally — untranslated
 * components simply keep their authored German strings.
 */
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import de from './locales/de.json'
import en from './locales/en.json'

export type AppLanguage = 'system' | 'de' | 'en'
export type ResolvedLanguage = 'de' | 'en'

export function resolveLanguage(preference: AppLanguage): ResolvedLanguage {
  if (preference === 'de' || preference === 'en') return preference
  try {
    return navigator.language?.toLowerCase().startsWith('de') ? 'de' : 'en'
  } catch {
    return 'en'
  }
}

void i18n.use(initReactI18next).init({
  resources: {
    de: { translation: de },
    en: { translation: en }
  },
  lng: resolveLanguage('system'),
  fallbackLng: 'en',
  interpolation: { escapeValue: false },
  returnEmptyString: false
})

/** Apply the persisted preference once the preload bridge is available. */
export async function initLanguageFromConfig(): Promise<void> {
  try {
    const stored = await window.vertragus?.getConfig<AppLanguage>('ui.language')
    const next = resolveLanguage(stored === 'de' || stored === 'en' ? stored : 'system')
    if (next !== i18n.language) await i18n.changeLanguage(next)
  } catch {
    // Missing bridge/config must never block rendering; the resolved default stays.
  }
}

/** Switch the UI language at runtime and persist the explicit choice. */
export async function setAppLanguage(language: ResolvedLanguage): Promise<void> {
  await i18n.changeLanguage(language)
  try {
    await window.vertragus?.setConfig('ui.language', language)
  } catch {
    // Persistence is best-effort; the live switch already happened.
  }
}

// Deterministic language for headless checks (ui-smoke asserts German labels).
declare global {
  interface Window {
    __setAppLanguage?: (language: ResolvedLanguage) => Promise<void>
  }
}
if (typeof window !== 'undefined') {
  window.__setAppLanguage = (language) => i18n.changeLanguage(language).then(() => undefined)
}

export default i18n
