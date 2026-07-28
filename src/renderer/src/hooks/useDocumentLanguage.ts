import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'

/**
 * Hält `document.documentElement.lang` synchron zur aktiven i18n-Sprache.
 * index.html liefert statisch lang="de"; dieser Hook korrigiert das Attribut
 * beim Start und bei jedem `languageChanged`-Event von i18next.
 */
export function useDocumentLanguage(): void {
  const { i18n } = useTranslation()
  useEffect(() => {
    const apply = (language: string): void => {
      document.documentElement.lang = language
    }
    apply(i18n.language)
    i18n.on('languageChanged', apply)
    return () => {
      i18n.off('languageChanged', apply)
    }
  }, [i18n])
}
