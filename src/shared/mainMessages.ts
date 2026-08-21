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
  /** Updater in a dev/unpackaged build — mirrors `settings.updateStatus.disabled`. */
  updatesDevBuild: string
  /** `install()` called while no finished download is waiting. */
  updateNotReady: string
  /** Remote bind resolution: auto mode found no Tailscale interface. */
  remoteNoTailscale: string
  /** Stored pairing-token ciphertext cannot be decrypted (locked keyring). */
  remoteTokenLocked: string
  /** Windows shim that cannot receive arguments faithfully (resolveLaunch). */
  noFaithfulLaunch: (command: string, resolved: string) => string
  /**
   * Model discovery failed on a missing login. `login` is the full provider
   * login command when the descriptor declares one; the CLI's own `failure`
   * sentence rides along because it names the alternatives (API key, env var).
   */
  authNotLoggedIn: (login: string | undefined, failure: string) => string
  /** Model discovery ran but the CLI/HTTP answer named no models. */
  discoveryNoModels: string
  /** A provider CLI was killed after `timeoutMs` without answering. */
  discoveryTimeout: (timeoutMs: number) => string
  /** OS-level window titles — set at window creation, shown by the OS chrome. */
  settingsWindowTitle: string
  profileEditorTitle: string
  providerEditorTitle: string
  zoneOverlayTitle: string
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
    hotkeyInvalid: (hotkey, reason) => `Hotkey ${hotkey} ist ungültig: ${reason}`,
    updatesDevBuild: 'Self-Updates laufen nur in der installierten App.',
    updateNotReady: 'Es liegt kein fertig geladenes Update bereit.',
    remoteNoTailscale:
      'Keine Tailscale-Adresse gefunden. Starte Tailscale, oder wähle in den Einstellungen eine andere Bind-Adresse.',
    remoteTokenLocked:
      'Kopplungs-Token konnte nicht entsperrt werden. Erzeuge in den Einstellungen einen neuen Code, oder entsperre den System-Schlüsselbund.',
    noFaithfulLaunch: (command, resolved) =>
      `Kein argumenttreuer Startpfad für '${command}' gefunden (aufgelöst zu ${resolved}). ` +
      'Ein cmd.exe/PowerShell-Wrapper würde mehrzeilige Prompts abschneiden und Shell-Metazeichen ' +
      'ausführbar machen. Erwartet wird ein direkt startbares .exe oder ein Node-Entrypoint neben dem Shim.',
    authNotLoggedIn: (login, failure) =>
      `nicht angemeldet — ${login ? `'${login}' ausführen` : 'bitte anmelden'} (${failure})`,
    discoveryNoModels: 'keine Modelle in der Antwort',
    discoveryTimeout: (timeoutMs) => `keine Antwort binnen ${timeoutMs} ms`,
    settingsWindowTitle: 'Vertragus — Einstellungen',
    profileEditorTitle: 'Vertragus — Profil',
    providerEditorTitle: 'Vertragus — Provider',
    zoneOverlayTitle: 'Vertragus — Zonen'
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
    hotkeyInvalid: (hotkey, reason) => `Hotkey ${hotkey} is invalid: ${reason}`,
    updatesDevBuild: 'Self-updates only run in the installed app.',
    updateNotReady: 'No finished update download is ready.',
    remoteNoTailscale:
      'No Tailscale address found. Start Tailscale, or pick another bind address in the settings.',
    remoteTokenLocked:
      'The pairing token could not be unlocked. Generate a new code in the settings, or unlock the system keyring.',
    noFaithfulLaunch: (command, resolved) =>
      `No argument-faithful launch path found for '${command}' (resolved to ${resolved}). ` +
      'A cmd.exe/PowerShell wrapper would truncate multi-line prompts and make shell metacharacters ' +
      'executable. Expected is a directly runnable .exe or a Node entrypoint next to the shim.',
    authNotLoggedIn: (login, failure) =>
      `not logged in — ${login ? `run '${login}'` : 'please log in'} (${failure})`,
    discoveryNoModels: 'no models in the response',
    discoveryTimeout: (timeoutMs) => `no reply within ${timeoutMs} ms`,
    settingsWindowTitle: 'Vertragus — Settings',
    profileEditorTitle: 'Vertragus — Profile',
    providerEditorTitle: 'Vertragus — Provider',
    zoneOverlayTitle: 'Vertragus — Zones'
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
