/**
 * Every visible string of the settings window. Same rule as the panel and the
 * profile editor: one object per surface, so the i18n pass lifts it into a
 * resource bundle unchanged.
 */
export const SETTINGS_STRINGS = {
  title: 'Einstellungen',
  subtitle: 'Gilt für Vertragus als Ganzes.',

  hotkey: 'Hotkey „Alles ausblenden“',
  hotkeyHint:
    'Electron-Format: Modifier mit + verbinden, z. B. Control+Alt+V. Wirkt sofort nach dem Speichern.',
  hotkeyPlaceholder: 'Control+Alt+V',
  hotkeySave: 'Übernehmen',
  hotkeyTaken: 'Gespeichert, aber nicht aktiv — siehe Meldung.',

  autostart: 'Mit Windows starten',
  autostartHint: 'Vertragus startet nach der Anmeldung automatisch.',
  autostartUnsupported:
    'Nur in der installierten App: im Entwicklungslauf würde der Autostart auf die Electron-Binärdatei zeigen.',

  updateChannel: 'Update-Kanal',
  updateChannelMain: 'main — jeder grüne Build',
  updateChannelStable: 'stable — nur veröffentlichte Versionen',
  updateChannelHint: 'main liefert Korrekturen am schnellsten, stable nur getaggte Versionen.',

  theme: 'Erscheinungsbild',
  themeDark: 'Dunkel',
  themeLight: 'Hell',
  themeHint: 'Wird gespeichert; das helle Thema kommt in einem späteren Schritt.',

  locale: 'Sprache',
  localeDe: 'Deutsch',
  localeEn: 'English',
  localeHint: 'Wird gespeichert; die Übersetzung kommt in einem späteren Schritt.',

  updates: 'Updates',
  updateCheck: 'Jetzt prüfen',
  updateInstall: 'Neu starten und installieren',
  updateVersion: (version: string): string => `Installiert: ${version}`,
  updateStatus: {
    disabled: 'Self-Updates laufen nur in der installierten App.',
    idle: 'Noch nicht geprüft.',
    checking: 'Suche nach Updates …',
    'up-to-date': 'Aktuell.',
    available: 'Update gefunden.',
    downloading: 'Update wird geladen …',
    downloaded: 'Update bereit — Neustart.',
    error: 'Update-Prüfung fehlgeschlagen.'
  } as Record<string, string>,
  updateAvailable: (version: string): string => `Version ${version} steht bereit.`,
  updateProgress: (percent: number): string => `${Math.round(percent)} %`,

  close: 'Schließen',
  saving: 'Speichert …',
  loading: 'Lädt …',
  bridgeMissing: 'Preload-Bridge nicht verfügbar.',

  errors: {
    hotkeyEmpty: 'Bitte einen Hotkey eingeben.',
    hotkeyNoModifier:
      'Ein globaler Hotkey braucht mindestens einen Modifier (Control, Alt, Shift, Super …).',
    hotkeyNoKey: 'Nach dem letzten + fehlt die eigentliche Taste.',
    hotkeyUnknownKey: (key: string): string => `„${key}" ist keine Taste, die Electron kennt.`,
    hotkeyUnknownModifier: (part: string): string => `„${part}" ist kein bekannter Modifier.`,
    hotkeyDuplicateModifier: (part: string): string => `„${part}" steht doppelt im Hotkey.`
  }
} as const
