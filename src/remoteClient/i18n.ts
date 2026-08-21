/**
 * Copy for the remote web client. The desktop renderer has i18next; this
 * bundle stays off that stack and follows the `hello.locale` the gateway
 * already sends, so a German desktop yields a German phone.
 */
export type RemoteLocale = 'de' | 'en'

export interface RemoteCopy {
  wordmark: string
  brandRemote: string
  connected: string
  connecting: string
  refresh: string
  pairingTitle: string
  pairingBody: string
  revokedTitle: string
  revokedBody: string
  errorTitle: string
  unknownError: string
  pairingFailed: string
  pairAgain: string
  empty: string
  ended: string
  endedCount: (count: number) => string
  hideEnded: string
  showEnded: (count: number) => string
  newWorkspace: string
  profile: string
  goalPlaceholder: string
  startWithGoal: string
  startWithoutGoal: string
  stop: string
  stopConfirm: string
  stopCancel: string
  inactive: string
  idleHint: string
  noGoal: string
  /** H2 refill: the button that folds the goal field out on a bare run. */
  assignGoal: string
  assignGoalSend: string
  goal: (goal: string) => string
  agents: (count: number) => string
  working: string
  waiting: string
  stopped: string
  openAgent: (name: string) => string
  answerQuestion: (name: string) => string
  userQuestion: (question: string) => string
  answerPlaceholder: string
  answerSend: string
  composerPlaceholder: string
  composerSend: string
  back: string
  terminalInput: string
  terminalLive: string
  terminalDead: string
  fontSmaller: string
  fontLarger: string
}

const de: RemoteCopy = {
  wordmark: 'VERTRAGVS',
  brandRemote: 'Fernzugriff',
  connected: 'verbunden',
  connecting: 'verbinde …',
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
  empty: 'Keine laufenden Workspaces.',
  ended: 'beendet',
  endedCount: (count) => (count === 1 ? '1 beendeter Workspace' : `${count} beendete Workspaces`),
  hideEnded: 'Beendete ausblenden',
  showEnded: (count) => `Beendete anzeigen (${count})`,
  newWorkspace: 'Neuer Workspace',
  profile: 'Profil',
  goalPlaceholder: 'Ziel für den Orchestrator … (leer = ohne Ziel starten)',
  startWithGoal: 'Mit Ziel starten',
  startWithoutGoal: 'Ohne Ziel starten',
  stop: 'Stop',
  stopConfirm: 'Wirklich beenden?',
  stopCancel: 'Abbrechen',
  inactive: 'beendet',
  idleHint: 'Orchestrator still — keine Tool-Aufrufe mehr',
  noGoal: 'Kein Ziel — Orchestrator wartet',
  assignGoal: 'Ziel nachtragen',
  assignGoalSend: 'Ziel setzen',
  goal: (goal) => `Ziel: ${goal}`,
  agents: (count) => (count === 1 ? '1 Agent' : `${count} Agenten`),
  working: 'arbeitet',
  waiting: 'wartet',
  stopped: 'beendet',
  openAgent: (name) => `Terminal von ${name} öffnen`,
  answerQuestion: (name) => `Frage von ${name} beantworten`,
  userQuestion: (question) => `Frage an dich: ${question}`,
  answerPlaceholder: 'Antwort …',
  answerSend: 'Antworten',
  composerPlaceholder: 'Nachricht an den Orchestrator …',
  composerSend: 'Senden',
  back: 'Zurück',
  terminalInput: 'Eingabe an den Agent …',
  terminalLive: 'läuft',
  terminalDead: 'beendet',
  fontSmaller: 'Schrift kleiner',
  fontLarger: 'Schrift größer'
}

const en: RemoteCopy = {
  wordmark: 'VERTRAGVS',
  brandRemote: 'Remote',
  connected: 'connected',
  connecting: 'connecting …',
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
  empty: 'No running workspaces.',
  ended: 'ended',
  endedCount: (count) => (count === 1 ? '1 ended workspace' : `${count} ended workspaces`),
  hideEnded: 'Hide ended',
  showEnded: (count) => `Show ended (${count})`,
  newWorkspace: 'New workspace',
  profile: 'Profile',
  goalPlaceholder: 'Goal for the orchestrator … (empty = start without a goal)',
  startWithGoal: 'Start with goal',
  startWithoutGoal: 'Start without goal',
  stop: 'Stop',
  stopConfirm: 'Stop this workspace?',
  stopCancel: 'Cancel',
  inactive: 'ended',
  idleHint: 'Orchestrator silent — no more tool calls',
  noGoal: 'No goal — the orchestrator is waiting',
  assignGoal: 'Set a goal',
  assignGoalSend: 'Set goal',
  goal: (goal) => `Goal: ${goal}`,
  agents: (count) => (count === 1 ? '1 agent' : `${count} agents`),
  working: 'working',
  waiting: 'waiting',
  stopped: 'stopped',
  openAgent: (name) => `Open ${name}’s terminal`,
  answerQuestion: (name) => `Answer ${name}’s question`,
  userQuestion: (question) => `Question for you: ${question}`,
  answerPlaceholder: 'Answer …',
  answerSend: 'Answer',
  composerPlaceholder: 'Message to the orchestrator …',
  composerSend: 'Send',
  back: 'Back',
  terminalInput: 'Input for the agent …',
  terminalLive: 'live',
  terminalDead: 'ended',
  fontSmaller: 'Smaller type',
  fontLarger: 'Larger type'
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
