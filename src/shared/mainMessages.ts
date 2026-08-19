/**
 * User-facing strings AUTHORED IN THE MAIN PROCESS — the quit dialog, thrown
 * errors that land in the panel banner, the hotkey failure note.
 *
 * The renderer's i18next bundles cannot help here: these strings surface in
 * native dialogs and in `Error` messages that travel through IPC rejection,
 * where no `t()` runs. This table is the main-side counterpart — same two
 * locales, same parity discipline (a test pins that both locales define every
 * key). Callers pass the stored UI locale; when none is reachable the German
 * default matches `uiSettingsSchema`'s locale default.
 */
export type MainLocale = 'de' | 'en'

interface MainMessages {
  /** Panel Play before the workspace manager is wired (boot failure). */
  stubNotWired: string
  unknownProfile: (profileId: string) => string
  quitTitle: string
  quitMessage: (runningAgents: number) => string
  quitDetail: string
  quitConfirm: string
  quitCancel: string
  hotkeyNone: string
  hotkeyTaken: (hotkey: string) => string
  hotkeyInvalid: (hotkey: string, reason: string) => string
}

const MESSAGES: Record<MainLocale, MainMessages> = {
  de: {
    stubNotWired: 'Workspace-Manager ist noch nicht verdrahtet.',
    unknownProfile: (profileId) => `Unbekanntes Profil ${profileId}`,
    quitTitle: 'Vertragus beenden',
    quitMessage: (runningAgents) =>
      `${runningAgents === 1 ? '1 Agent läuft' : `${runningAgents} Agenten laufen`} noch — Vertragus beenden?`,
    quitDetail: 'Alle Agenten-Prozesse werden gestoppt.',
    quitConfirm: 'Beenden',
    quitCancel: 'Abbrechen',
    hotkeyNone: 'Kein Hotkey konfiguriert.',
    hotkeyTaken: (hotkey) =>
      `Hotkey ${hotkey} ist belegt — eine andere Anwendung hat ihn zuerst registriert.`,
    hotkeyInvalid: (hotkey, reason) => `Hotkey ${hotkey} ist ungültig: ${reason}`
  },
  en: {
    stubNotWired: 'The workspace manager is not wired up yet.',
    unknownProfile: (profileId) => `Unknown profile ${profileId}`,
    quitTitle: 'Quit Vertragus',
    quitMessage: (runningAgents) =>
      `${runningAgents === 1 ? '1 agent is' : `${runningAgents} agents are`} still running — quit Vertragus?`,
    quitDetail: 'All agent processes will be stopped.',
    quitConfirm: 'Quit',
    quitCancel: 'Cancel',
    hotkeyNone: 'No hotkey configured.',
    hotkeyTaken: (hotkey) =>
      `Hotkey ${hotkey} is taken — another application registered it first.`,
    hotkeyInvalid: (hotkey, reason) => `Hotkey ${hotkey} is invalid: ${reason}`
  }
}

export function mainMessages(locale: string | undefined): MainMessages {
  return locale === 'en' ? MESSAGES.en : MESSAGES.de
}

/** Fail-soft locale read: a corrupt store must cost the language, not the message. */
export function readLocale(get: () => string | undefined): string | undefined {
  try {
    return get()
  } catch {
    return undefined
  }
}
