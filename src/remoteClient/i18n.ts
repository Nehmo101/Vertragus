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
  brandRemote: string
  connected: string
  connecting: string
  reconnecting: string
  offline: string
  connectionLost: string
  refresh: string
  pairingTitle: string
  pairingBody: string
  revokedTitle: string
  revokedBody: string
  errorTitle: string
  unknownError: string
  pairingFailed: string
  pairAgain: string
  themeFollowHost: string
  themeDark: string
  themeLight: string
  themeToggle: (next: string) => string
  // --- overview ----------------------------------------------------------
  empty: string
  emptyHint: string
  ended: string
  endedCount: (count: number) => string
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
  brandRemote: 'Fernzugriff',
  connected: 'verbunden',
  connecting: 'verbinde …',
  reconnecting: 'verbinde neu …',
  offline: 'offline',
  connectionLost: 'Verbindung unterbrochen.',
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
  pairAgain: 'Erneut koppeln',
  themeFollowHost: 'Desktop folgen',
  themeDark: 'Dunkel',
  themeLight: 'Hell',
  themeToggle: (next) => `Darstellung umschalten (${next})`,
  empty: 'Keine laufenden Workspaces.',
  emptyHint: 'Starte oben einen Workspace aus einem Profil.',
  ended: 'beendet',
  endedCount: (count) => (count === 1 ? '1 beendeter Workspace' : `${count} beendete Workspaces`),
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
  brandRemote: 'Remote',
  connected: 'connected',
  connecting: 'connecting …',
  reconnecting: 'reconnecting …',
  offline: 'offline',
  connectionLost: 'Connection lost.',
  refresh: 'Refresh',
  pairingTitle: 'Pair Vertragus',
  pairingBody:
    'Open the pairing link (QR code) from Vertragus settings to connect this device. The link stays the same across restarts.',
  revokedTitle: 'Session ended',
  revokedBody: 'The session was ended. Open the pairing link (QR code) from Vertragus settings again.',
  errorTitle: 'Connection failed',
  unknownError: 'Unknown error.',
  pairingFailed: 'Pairing failed — the link has expired or is invalid.',
  pairAgain: 'Pair again',
  themeFollowHost: 'Follow desktop',
  themeDark: 'Dark',
  themeLight: 'Light',
  themeToggle: (next) => `Switch appearance (${next})`,
  empty: 'No running workspaces.',
  emptyHint: 'Start a workspace from a profile above.',
  ended: 'ended',
  endedCount: (count) => (count === 1 ? '1 ended workspace' : `${count} ended workspaces`),
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
