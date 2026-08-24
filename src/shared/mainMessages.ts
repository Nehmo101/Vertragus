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
  /** OS-level window titles — set at window creation, shown by the OS chrome. */
  settingsWindowTitle: string
  profileEditorTitle: string
  providerEditorTitle: string
  zoneOverlayTitle: string
  /**
   * Voice assistant: the mic is on but no xAI key is stored. Said in the
   * panel's voice badge, so it names the two places a key can come from.
   */
  voiceMissingApiKey: string
  /** Same as {@link voiceMissingApiKey} when the selected provider is OpenAI. */
  voiceMissingOpenaiApiKey: string
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
    settingsWindowTitle: 'Vertragus — Einstellungen',
    profileEditorTitle: 'Vertragus — Profil',
    providerEditorTitle: 'Vertragus — Provider',
    zoneOverlayTitle: 'Vertragus — Zonen',
    voiceMissingApiKey: 'Kein xAI-API-Key. Unter Einstellungen eintragen oder XAI_API_KEY setzen.',
    voiceMissingOpenaiApiKey:
      'Kein OpenAI-API-Key. Unter Einstellungen eintragen oder OPENAI_API_KEY setzen.'
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
    settingsWindowTitle: 'Vertragus — Settings',
    profileEditorTitle: 'Vertragus — Profile',
    providerEditorTitle: 'Vertragus — Provider',
    zoneOverlayTitle: 'Vertragus — Zones',
    voiceMissingApiKey: 'No xAI API key. Set it under Settings or XAI_API_KEY.',
    voiceMissingOpenaiApiKey: 'No OpenAI API key. Set it under Settings or OPENAI_API_KEY.'
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
