/**
 * Copy for the remote web client. The desktop renderer has i18next; this
 * bundle stays off that stack and follows the `hello.locale` the gateway
 * already sends, so a German desktop yields a German phone.
 *
 * German is the authored column, English the translation — `i18n.test.ts`
 * fails on an empty string, on a function pair whose arities diverge, and on
 * German letters that leaked into the English block.
 */
export type RemoteLocale = 'de' | 'en'

export interface RemoteCopy {
  // --- shell -------------------------------------------------------------
  wordmark: string
  connected: string
  connecting: string
  reconnecting: string
  offline: string
  connectionLost: string
  /**
   * The two halves of the wire's argument cap: `lengthLimit` is the field
   * sitting at it, `commandTooLong` is a send refused for exceeding it. Both
   * exist because a field can be filled by a paste that outruns its own
   * maxLength on some browsers.
   */
  commandTooLong: string
  refresh: string
  pairingTitle: string
  pairingBody: string
  revokedTitle: string
  revokedBody: string
  errorTitle: string
  unknownError: string
  pairingFailed: string
  /**
   * Distinct from `pairingFailed` on purpose: the desktop said no, versus the
   * desktop could not be reached at all. Only the first justifies sending the
   * user back to the QR code — the second is a phone that walked out of the
   * tailnet and will be fine in a minute.
   */
  unreachable: string
  retry: string
  retrying: string
  pairAgain: string
  themeFollowHost: string
  themeDark: string
  themeLight: string
  themeToggle: (next: string) => string
  // --- overview ----------------------------------------------------------
  empty: string
  emptyHint: string
  hideEnded: string
  showEnded: (count: number) => string
  newWorkspace: string
  profile: string
  goalPlaceholder: string
  startWithGoal: string
  startWithoutGoal: string
  starting: string
  stop: string
  stopConfirm: string
  stopCancel: string
  inactive: string
  idleHint: string
  noGoal: string
  goal: (goal: string) => string
  agents: (count: number) => string
  working: string
  waiting: string
  stopped: string
  openAgent: (name: string) => string
  collapseCard: (name: string) => string
  expandCard: (name: string) => string
  collapseAll: string
  expandAll: string
  backToTop: string
  pullToRefresh: string
  releaseToRefresh: string
  refreshing: string
  // --- questions ---------------------------------------------------------
  inboxTitle: string
  inboxCount: (count: number) => string
  inboxJump: (name: string) => string
  inboxPillLabel: (count: number) => string
  answerQuestion: (name: string) => string
  userQuestion: (question: string) => string
  answerPlaceholder: string
  answerSend: string
  answerSending: string
  dismissAnswer: string
  composerPlaceholder: string
  composerSend: string
  composerSent: string
  // --- task board --------------------------------------------------------
  tasksTitle: string
  showTasks: (count: number) => string
  hideTasks: string
  taskPending: string
  taskInProgress: string
  taskCompleted: string
  taskReady: string
  taskBlocked: (count: number) => string
  taskOwner: (name: string) => string
  taskNotReady: string
  justEnded: string
  endedWhileHere: string
  stopping: string
  unsentTitle: string
  unsentAnswer: (source: string) => string
  unsentComposer: (source: string) => string
  unsentElsewhere: string
  discardDraft: string
  lengthLimit: (max: number) => string
  // --- terminal ----------------------------------------------------------
  back: string
  terminalInput: string
  terminalLive: string
  terminalDead: string
  terminalExit: (code: number) => string
  fontSmaller: string
  fontLarger: string
  keyRowLabel: string
  pageUp: string
  pageDown: string
  toTop: string
  toBottom: string
  jumpToLatest: string
  following: string
  paused: string
  searchOpen: string
  searchClose: string
  searchPlaceholder: string
  searchNext: string
  searchPrev: string
  searchNoMatch: string
  searchResult: (index: number, count: number) => string
  terminalRegion: string
  historyControls: string
  copyBuffer: string
  copyDone: string
  copyFailed: string
}

const de: RemoteCopy = {
  wordmark: 'VERTRAGVS',
  connected: 'verbunden',
  connecting: 'verbinde …',
  reconnecting: 'verbinde neu …',
  offline: 'offline',
  connectionLost: 'Verbindung unterbrochen.',
  commandTooLong: 'Der Text ist zu lang für eine Übertragung — bitte kürzen.',
  refresh: 'Aktualisieren',
  pairingTitle: 'Vertragus koppeln',
  pairingBody:
    'Öffne den Kopplungs-Link (QR-Code) aus den Vertragus-Einstellungen, um dieses Gerät zu verbinden. Der Link bleibt über Neustarts gleich.',
  revokedTitle: 'Sitzung beendet',
  revokedBody:
    'Die Sitzung wurde beendet. Öffne den Kopplungs-Link (QR-Code) aus den Vertragus-Einstellungen erneut.',
  errorTitle: 'Verbindung fehlgeschlagen',
  unknownError: 'Unbekannter Fehler.',
  pairingFailed: 'Pairing fehlgeschlagen — der Link ist abgelaufen oder ungültig.',
  unreachable:
    'Vertragus ist nicht erreichbar. Läuft der Desktop, und ist dieses Gerät im selben Tailnet?',
  retry: 'Erneut versuchen',
  retrying: 'versuche erneut …',
  pairAgain: 'Erneut koppeln',
  themeFollowHost: 'Desktop folgen',
  themeDark: 'Dunkel',
  themeLight: 'Hell',
  themeToggle: (next) => `Darstellung umschalten (${next})`,
  empty: 'Keine laufenden Workspaces.',
  emptyHint: 'Starte oben einen Workspace aus einem Profil.',
  hideEnded: 'Beendete ausblenden',
  showEnded: (count) => `Beendete anzeigen (${count})`,
  newWorkspace: 'Neuer Workspace',
  profile: 'Profil',
  goalPlaceholder: 'Ziel für den Orchestrator … (leer = ohne Ziel starten)',
  startWithGoal: 'Mit Ziel starten',
  startWithoutGoal: 'Ohne Ziel starten',
  starting: 'startet …',
  stop: 'Stop',
  stopConfirm: 'Wirklich beenden?',
  stopCancel: 'Abbrechen',
  inactive: 'beendet',
  idleHint: 'Orchestrator still — keine Tool-Aufrufe mehr',
  noGoal: 'Kein Ziel — Orchestrator wartet',
  goal: (goal) => `Ziel: ${goal}`,
  agents: (count) => (count === 1 ? '1 Agent' : `${count} Agenten`),
  working: 'arbeitet',
  waiting: 'wartet',
  stopped: 'beendet',
  openAgent: (name) => `Terminal von ${name} öffnen`,
  collapseCard: (name) => `${name} einklappen`,
  expandCard: (name) => `${name} ausklappen`,
  collapseAll: 'Alle einklappen',
  expandAll: 'Alle ausklappen',
  backToTop: 'Nach oben',
  pullToRefresh: 'Zum Aktualisieren ziehen',
  releaseToRefresh: 'Loslassen zum Aktualisieren',
  refreshing: 'aktualisiere …',
  inboxTitle: 'Offene Fragen',
  inboxCount: (count) => (count === 1 ? '1 offene Frage' : `${count} offene Fragen`),
  inboxJump: (name) => `Zu ${name} springen`,
  inboxPillLabel: (count) =>
    count === 1 ? 'Zu 1 offenen Frage springen' : `Zu ${count} offenen Fragen springen`,
  answerQuestion: (name) => `Frage von ${name} beantworten`,
  userQuestion: (question) => `Frage an dich: ${question}`,
  answerPlaceholder: 'Antwort …',
  answerSend: 'Antworten',
  answerSending: 'sende …',
  dismissAnswer: 'Antwortfeld schließen',
  composerPlaceholder: 'Nachricht an den Orchestrator …',
  composerSend: 'Senden',
  composerSent: 'gesendet',
  tasksTitle: 'Aufgaben',
  showTasks: (count) => `Aufgaben anzeigen (${count})`,
  hideTasks: 'Aufgaben ausblenden',
  taskPending: 'offen',
  taskInProgress: 'läuft',
  taskCompleted: 'fertig',
  taskReady: 'bereit',
  taskBlocked: (count) => (count === 1 ? 'wartet auf 1 Aufgabe' : `wartet auf ${count} Aufgaben`),
  taskOwner: (name) => `bei ${name}`,
  taskNotReady: 'noch nicht bereit',
  justEnded: 'gerade beendet',
  endedWhileHere: 'Der Lauf ist beendet — die Karte bleibt an ihrem Platz.',
  stopping: 'beende …',
  unsentTitle: 'Nicht gesendeter Text',
  unsentAnswer: (source) => `Antwort für ${source} — die Frage ist inzwischen beantwortet`,
  unsentComposer: (source) => `Nachricht an ${source} — der Lauf ist beendet`,
  unsentElsewhere: 'Das Feld dazu gibt es nicht mehr.',
  discardDraft: 'Verwerfen',
  lengthLimit: (max) => `Maximale Länge erreicht (${max} Zeichen).`,
  back: 'Zurück',
  terminalInput: 'Eingabe an den Agent …',
  terminalLive: 'läuft',
  terminalDead: 'beendet',
  terminalExit: (code) => `beendet · exit ${code}`,
  fontSmaller: 'Schrift kleiner',
  fontLarger: 'Schrift größer',
  keyRowLabel: 'Steuertasten',
  pageUp: 'Seite hoch',
  pageDown: 'Seite runter',
  toTop: 'Zum Anfang',
  toBottom: 'Zum Ende',
  jumpToLatest: 'Neueste Ausgabe',
  following: 'folgt der Ausgabe',
  paused: 'Verlauf angehalten',
  searchOpen: 'Im Verlauf suchen',
  searchClose: 'Suche schließen',
  searchPlaceholder: 'Im Verlauf suchen …',
  searchNext: 'Weiter',
  searchPrev: 'Zurück',
  searchNoMatch: 'kein Treffer',
  searchResult: (index, count) => `Treffer ${index} von ${count}`,
  terminalRegion: 'Terminal-Ausgabe',
  historyControls: 'Verlaufssteuerung',
  copyBuffer: 'Verlauf kopieren',
  copyDone: 'kopiert',
  copyFailed: 'Kopieren fehlgeschlagen'
}

const en: RemoteCopy = {
  wordmark: 'VERTRAGVS',
  connected: 'connected',
  connecting: 'connecting …',
  reconnecting: 'reconnecting …',
  offline: 'offline',
  connectionLost: 'Connection lost.',
  commandTooLong: 'That text is too long to send — please shorten it.',
  refresh: 'Refresh',
  pairingTitle: 'Pair Vertragus',
  pairingBody:
    'Open the pairing link (QR code) from Vertragus settings to connect this device. The link stays the same across restarts.',
  revokedTitle: 'Session ended',
  revokedBody: 'The session was ended. Open the pairing link (QR code) from Vertragus settings again.',
  errorTitle: 'Connection failed',
  unknownError: 'Unknown error.',
  pairingFailed: 'Pairing failed — the link has expired or is invalid.',
  unreachable:
    'Vertragus cannot be reached. Is the desktop running, and is this device on the same tailnet?',
  retry: 'Try again',
  retrying: 'retrying …',
  pairAgain: 'Pair again',
  themeFollowHost: 'Follow desktop',
  themeDark: 'Dark',
  themeLight: 'Light',
  themeToggle: (next) => `Switch appearance (${next})`,
  empty: 'No running workspaces.',
  emptyHint: 'Start a workspace from a profile above.',
  hideEnded: 'Hide ended',
  showEnded: (count) => `Show ended (${count})`,
  newWorkspace: 'New workspace',
  profile: 'Profile',
  goalPlaceholder: 'Goal for the orchestrator … (empty = start without a goal)',
  startWithGoal: 'Start with goal',
  startWithoutGoal: 'Start without goal',
  starting: 'starting …',
  stop: 'Stop',
  stopConfirm: 'Stop this workspace?',
  stopCancel: 'Cancel',
  inactive: 'ended',
  idleHint: 'Orchestrator silent — no more tool calls',
  noGoal: 'No goal — the orchestrator is waiting',
  goal: (goal) => `Goal: ${goal}`,
  agents: (count) => (count === 1 ? '1 agent' : `${count} agents`),
  working: 'working',
  waiting: 'waiting',
  stopped: 'stopped',
  openAgent: (name) => `Open ${name}’s terminal`,
  collapseCard: (name) => `Collapse ${name}`,
  expandCard: (name) => `Expand ${name}`,
  collapseAll: 'Collapse all',
  expandAll: 'Expand all',
  backToTop: 'Back to top',
  pullToRefresh: 'Pull to refresh',
  releaseToRefresh: 'Release to refresh',
  refreshing: 'refreshing …',
  inboxTitle: 'Open questions',
  inboxCount: (count) => (count === 1 ? '1 open question' : `${count} open questions`),
  inboxJump: (name) => `Jump to ${name}`,
  inboxPillLabel: (count) =>
    count === 1 ? 'Jump to 1 open question' : `Jump to ${count} open questions`,
  answerQuestion: (name) => `Answer ${name}’s question`,
  userQuestion: (question) => `Question for you: ${question}`,
  answerPlaceholder: 'Answer …',
  answerSend: 'Answer',
  answerSending: 'sending …',
  dismissAnswer: 'Close the answer field',
  composerPlaceholder: 'Message to the orchestrator …',
  composerSend: 'Send',
  composerSent: 'sent',
  tasksTitle: 'Tasks',
  showTasks: (count) => `Show tasks (${count})`,
  hideTasks: 'Hide tasks',
  taskPending: 'pending',
  taskInProgress: 'in progress',
  taskCompleted: 'done',
  taskReady: 'ready',
  taskBlocked: (count) => (count === 1 ? 'waiting on 1 task' : `waiting on ${count} tasks`),
  taskOwner: (name) => `with ${name}`,
  taskNotReady: 'not ready yet',
  justEnded: 'just ended',
  endedWhileHere: 'The run ended — the card keeps its place.',
  stopping: 'stopping …',
  unsentTitle: 'Unsent text',
  unsentAnswer: (source) => `Answer for ${source} — the question has since been answered`,
  unsentComposer: (source) => `Message to ${source} — the run has ended`,
  unsentElsewhere: 'The field it belonged to is gone.',
  discardDraft: 'Discard',
  lengthLimit: (max) => `Maximum length reached (${max} characters).`,
  back: 'Back',
  terminalInput: 'Input for the agent …',
  terminalLive: 'live',
  terminalDead: 'ended',
  terminalExit: (code) => `ended · exit ${code}`,
  fontSmaller: 'Smaller type',
  fontLarger: 'Larger type',
  keyRowLabel: 'Control keys',
  pageUp: 'Page up',
  pageDown: 'Page down',
  toTop: 'To the top',
  toBottom: 'To the end',
  jumpToLatest: 'Latest output',
  following: 'following output',
  paused: 'history paused',
  searchOpen: 'Search the history',
  searchClose: 'Close search',
  searchPlaceholder: 'Search the history …',
  searchNext: 'Next',
  searchPrev: 'Previous',
  searchNoMatch: 'no match',
  searchResult: (index, count) => `Match ${index} of ${count}`,
  terminalRegion: 'Terminal output',
  historyControls: 'History controls',
  copyBuffer: 'Copy the history',
  copyDone: 'copied',
  copyFailed: 'Copying failed'
}

/**
 * The one place the host's `hello.locale` is reduced to a language: BCP-47
 * variants of English count as English, anything else falls back to the
 * authored German. Exported because the copy is not the only thing that
 * follows it — `App.tsx` sets `document.documentElement.lang` from it, and the
 * two must never disagree.
 */
export function remoteLanguage(locale: string): RemoteLocale {
  return locale.toLowerCase().startsWith('en') ? 'en' : 'de'
}

export function remoteCopy(locale: string): RemoteCopy {
  return remoteLanguage(locale) === 'en' ? en : de
}
