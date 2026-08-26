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
  /** Panel Play before the workspace manager is wired (no reason recorded). */
  stubNotWired: string
  /**
   * Same refusal, but the boot DID fail and said why. The reason is the thrown
   * message from `startMcpServer()`; without it the panel blames an unfinished
   * feature while the only account of the real failure sits in a console the
   * user cannot open.
   */
  stubBootFailed: (reason: string) => string
  unknownProfile: (profileId: string) => string
  /**
   * Worktree cleanup refused a removal: the path is not in the CURRENT stale
   * list. Which of the three reasons applies is deliberately not narrowed —
   * the list is re-read per click, so an answer naming one could already be
   * wrong by the time it is read.
   */
  worktreeNotRemovable: (worktreePath: string) => string
  /**
   * Panel Resume with nothing journaled in the repository — very likely on a
   * first run, and reached by an ordinary button press.
   */
  resumeNoRun: (repoPath: string) => string
  /** Orchestrator succession: a successor is already on its way. */
  successorAlreadyStarting: string
  /** Orchestrator succession: this workspace never had an orchestrator. */
  noOrchestrator: string
  /**
   * H2 refill: the goal field was submitted for a run that already has a
   * goal — a second one would type a first turn into a CLI that is already
   * driving the loop. Steering an existing run is the composer's job.
   */
  goalAlreadySet: string
  /** Promote left the branch untouched because the merge conflicted. */
  promoteConflict: (conflictFiles: string) => string
  /** Git named no paths in the conflict — the list must still say something. */
  unknownConflictFiles: string
  /** The answered question closed between render and click. */
  answerQuestionClosed: string
  /** The answered question belongs to a different agent than the one clicked. */
  answerAgentMismatch: string
  /** The agent could not be reached; the question stays open. */
  answerNotDelivered: (reason: string | undefined) => string
  /** `shell.openPath` refused the run folder (never written, or removed). */
  runFolderNotOpened: (dir: string, reason: string) => string
  quitTitle: string
  quitMessage: (runningAgents: number) => string
  quitDetail: string
  quitConfirm: string
  quitCancel: string
  hotkeyNone: string
  hotkeyTaken: (hotkey: string) => string
  hotkeyInvalid: (hotkey: string, reason: string) => string
  /**
   * The settings store itself could not be read. No locale is reachable in
   * that state, so this one always renders in the schema-default language —
   * the key exists so the sentence still lives in the table, not in main.
   */
  settingsUnreadable: (reason: string) => string
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
  /**
   * Windows taskbar overlay description while a human question is open.
   * Spoken as the overlay's accessible name; not an OS Notification toast.
   */
  panelAttentionOverlay: string
  /** OS-level window titles — set at window creation, shown by the OS chrome. */
  settingsWindowTitle: string
  profileEditorTitle: string
  providerEditorTitle: string
  zoneOverlayTitle: string
  timelineWindowTitle: string
  /**
   * Voice assistant: the mic is on but no xAI key is stored. Said in the
   * panel's voice badge, so it names the two places a key can come from.
   */
  voiceMissingApiKey: string
  /** Same as {@link voiceMissingApiKey} when the selected provider is OpenAI. */
  voiceMissingOpenaiApiKey: string
  /**
   * Seed handshake: Windows Application Control (Smart App Control / AppLocker
   * / WDAC) blocked a native `.node` addon. `blockedPath` is the file the CLI
   * named, or {@link cliNativeAddon} when the dump had no path.
   */
  cliBlockedByAppControl: (name: string, provider: string, blockedPath: string) => string
  /** Fallback label when the dump named no `.node` path. */
  cliNativeAddon: string
  /** Seed handshake: orchestrator prompt never landed. */
  cliNeverReadyPrompt: (name: string, provider: string) => string
  /**
   * Image attach: the file is larger than the 8 MiB cap. A correct renderer
   * can provoke this (a big drop), so it is localized.
   */
  attachmentTooLarge: string
  /** Image attach: magic bytes were not a supported image type. */
  attachmentNotImage: string
  /** Image attach: pre-start staging expired or was already consumed. */
  attachmentStagingExpired: string
  /**
   * Image attach: the agent's worktree is not on disk yet (boot overlay) or
   * the agent is unknown.
   */
  attachmentWorktreeMissing: string
  /** Seed handshake: subagent task never landed. */
  cliNeverReadyTask: (name: string, provider: string) => string
  /** Seed handshake: lead area never landed. */
  cliNeverReadyArea: (name: string, provider: string) => string
  /** Quoted PTY tail appended to a generic seed failure. */
  cliOutputExcerpt: (excerpt: string) => string
  /** Native save-dialog title for a profile export. */
  profileExportTitle: string
  /** Native open-dialog title for a profile import. */
  profileImportTitle: string
  /** File-type filter label shared by both dialogs. */
  profileFileFilter: string
  /** Name suffix when an imported profile's name is already taken. */
  profileImportedWord: string
  /** Picked file is not a Vertragus profile (bad JSON or foreign envelope). */
  profileImportInvalid: string
  /** Picked file is larger than the portable-profile cap. */
  profileImportTooLarge: string
  /** Picked file could not be read. */
  profileImportUnreadable: (reason: string) => string
  /** Save path could not be written. */
  profileExportFailed: (reason: string) => string
}

const MESSAGES: Record<MainLocale, MainMessages> = {
  de: {
    stubNotWired: 'Workspace-Manager ist noch nicht verdrahtet.',
    stubBootFailed: (reason) =>
      `Workspace-Manager konnte nicht starten — Agenten lassen sich nicht anlegen: ${reason}`,
    unknownProfile: (profileId) => `Unbekanntes Profil ${profileId}`,
    worktreeNotRemovable: (worktreePath) =>
      `Worktree ${worktreePath} ist nicht entfernbar — er ist aktiv, fremd oder existiert nicht.`,
    resumeNoRun: (repoPath) =>
      `Fortsetzen abgelehnt — in ${repoPath} liegt kein aufgezeichneter Lauf.`,
    successorAlreadyStarting: 'Orchestrator-Wechsel abgelehnt — ein Nachfolger startet bereits.',
    noOrchestrator: 'Orchestrator-Wechsel abgelehnt — dieser Workspace hat keinen Orchestrator.',
    goalAlreadySet:
      'Ziel abgelehnt — dieser Lauf hat bereits ein Ziel. Nutze die Nachricht, um ihn zu steuern.',
    promoteConflict: (conflictFiles) =>
      `Merge-Konflikt — es wurde nichts geändert. Betroffene Dateien: ${conflictFiles}`,
    unknownConflictFiles: '(unbekannt)',
    answerQuestionClosed:
      'Antwort abgelehnt — diese Frage ist bereits beantwortet oder nicht mehr offen.',
    answerAgentMismatch: 'Antwort abgelehnt — die Frage gehört zu einem anderen Agenten.',
    answerNotDelivered: (reason) =>
      `Antwort nicht zugestellt — die Frage bleibt offen (${reason ?? 'Zustellung fehlgeschlagen'}).`,
    runFolderNotOpened: (dir, reason) =>
      `Lauf-Ordner ${dir} konnte nicht geöffnet werden — ${reason}`,
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
    settingsUnreadable: (reason) => `Einstellungen nicht lesbar: ${reason}`,
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
    panelAttentionOverlay: 'Offene Frage',
    settingsWindowTitle: 'Vertragus — Einstellungen',
    profileEditorTitle: 'Vertragus — Profil',
    providerEditorTitle: 'Vertragus — Provider',
    zoneOverlayTitle: 'Vertragus — Zonen',
    timelineWindowTitle: 'Vertragus — Übersicht',
    voiceMissingApiKey: 'Kein xAI-API-Key. Unter Einstellungen eintragen oder XAI_API_KEY setzen.',
    voiceMissingOpenaiApiKey:
      'Kein OpenAI-API-Key. Unter Einstellungen eintragen oder OPENAI_API_KEY setzen.',
    cliBlockedByAppControl: (name, provider, blockedPath) =>
      `${name} (${provider}) konnte nicht starten — Windows Application Control hat ${blockedPath} ` +
      'blockiert (Smart App Control, AppLocker oder WDAC). Vertragus kann diese Richtlinie nicht ' +
      'umgehen. Smart App Control ausschalten oder eine Ausnahme für %LOCALAPPDATA%\\cursor-agent ' +
      'setzen. Siehe docs/TROUBLESHOOTING.md.',
    cliNativeAddon: 'ein natives .node-Addon',
    attachmentTooLarge: 'Bild abgelehnt — größer als 8 MiB.',
    attachmentNotImage: 'Kein unterstütztes Bild (png, jpeg, gif, webp, bmp).',
    attachmentStagingExpired: 'Das Bild ist abgelaufen — bitte erneut einfügen.',
    attachmentWorktreeMissing:
      'Bild abgelehnt — das Agent-Worktree ist noch nicht bereit.',
    cliNeverReadyPrompt: (name, provider) =>
      `${name} (${provider}) wurde nicht bereit — der Orchestrator-Prompt wurde nicht zugestellt.`,
    cliNeverReadyTask: (name, provider) =>
      `${name} (${provider}) wurde nicht bereit — die CLI hat ihre Aufgabe nicht angenommen.`,
    cliNeverReadyArea: (name, provider) =>
      `${name} (${provider}) wurde nicht bereit — die CLI hat ihren Bereich nicht angenommen.`,
    cliOutputExcerpt: (excerpt) => `CLI-Ausgabe:\n${excerpt}`,
    profileExportTitle: 'Profil exportieren',
    profileImportTitle: 'Profil importieren',
    profileFileFilter: 'Vertragus-Profil',
    profileImportedWord: 'importiert',
    profileImportInvalid: 'Import abgelehnt — die Datei ist kein Vertragus-Profil.',
    profileImportTooLarge: 'Import abgelehnt — die Datei ist zu groß.',
    profileImportUnreadable: (reason) => `Import abgelehnt — Datei nicht lesbar (${reason}).`,
    profileExportFailed: (reason) => `Export abgelehnt — ${reason}`
  },
  en: {
    stubNotWired: 'The workspace manager is not wired up yet.',
    stubBootFailed: (reason) =>
      `The workspace manager could not start — no agents can be launched: ${reason}`,
    unknownProfile: (profileId) => `Unknown profile ${profileId}`,
    worktreeNotRemovable: (worktreePath) =>
      `Worktree ${worktreePath} cannot be removed — it is active, foreign, or does not exist.`,
    resumeNoRun: (repoPath) => `Resume rejected — no journaled run found in ${repoPath}.`,
    successorAlreadyStarting:
      'Orchestrator replacement rejected — a successor is already starting.',
    noOrchestrator: 'Orchestrator replacement rejected — this workspace has no orchestrator.',
    goalAlreadySet:
      'Goal rejected — this run already has a goal. Send a message to steer it instead.',
    promoteConflict: (conflictFiles) =>
      `Merge conflict — nothing was changed. Conflicting files: ${conflictFiles}`,
    unknownConflictFiles: '(unknown)',
    answerQuestionClosed:
      'Answer rejected — that question is already answered or no longer open.',
    answerAgentMismatch: 'Answer rejected — the question belongs to a different agent.',
    answerNotDelivered: (reason) =>
      `Answer not delivered — the question is still open (${reason ?? 'delivery failed'}).`,
    runFolderNotOpened: (dir, reason) => `Run folder ${dir} could not be opened — ${reason}`,
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
    settingsUnreadable: (reason) => `Settings could not be read: ${reason}`,
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
    panelAttentionOverlay: 'Open question',
    settingsWindowTitle: 'Vertragus — Settings',
    profileEditorTitle: 'Vertragus — Profile',
    providerEditorTitle: 'Vertragus — Provider',
    zoneOverlayTitle: 'Vertragus — Zones',
    timelineWindowTitle: 'Vertragus — Timeline',
    voiceMissingApiKey: 'No xAI API key. Set it under Settings or XAI_API_KEY.',
    voiceMissingOpenaiApiKey: 'No OpenAI API key. Set it under Settings or OPENAI_API_KEY.',
    cliBlockedByAppControl: (name, provider, blockedPath) =>
      `${name} (${provider}) could not start — Windows Application Control blocked ${blockedPath} ` +
      '(Smart App Control, AppLocker, or WDAC). Vertragus cannot override that policy. Turn Smart ' +
      'App Control off, or add an exception for %LOCALAPPDATA%\\cursor-agent. See ' +
      'docs/TROUBLESHOOTING.md.',
    cliNativeAddon: 'a native .node addon',
    attachmentTooLarge: 'Image rejected — larger than 8 MiB.',
    attachmentNotImage: 'Not a supported image (png, jpeg, gif, webp, bmp).',
    attachmentStagingExpired: 'That image expired — paste it again.',
    attachmentWorktreeMissing: 'Image rejected — the agent worktree is not ready yet.',
    cliNeverReadyPrompt: (name, provider) =>
      `${name} (${provider}) never became ready — the orchestrator prompt was not delivered.`,
    cliNeverReadyTask: (name, provider) =>
      `${name} (${provider}) never became ready — the CLI did not accept its task.`,
    cliNeverReadyArea: (name, provider) =>
      `${name} (${provider}) never became ready — the CLI did not accept its area.`,
    cliOutputExcerpt: (excerpt) => `CLI output:\n${excerpt}`,
    profileExportTitle: 'Export profile',
    profileImportTitle: 'Import profile',
    profileFileFilter: 'Vertragus profile',
    profileImportedWord: 'imported',
    profileImportInvalid: 'Import rejected — the file is not a Vertragus profile.',
    profileImportTooLarge: 'Import rejected — the file is too large.',
    profileImportUnreadable: (reason) => `Import rejected — the file could not be read (${reason}).`,
    profileExportFailed: (reason) => `Export rejected — ${reason}`
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
