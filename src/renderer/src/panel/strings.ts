/**
 * Every visible string of the panel, in one place.
 *
 * The UI is German today; i18n (DE/EN) lands in M6. Collecting the copy here
 * instead of inlining it into JSX makes that migration a mechanical move of one
 * object into a resource bundle — and it is already the only place to look when
 * a wording changes.
 */
export const PANEL_STRINGS = {
  wordmark: 'VERTRAGVS',
  profilesLabel: 'Profile',
  workspacesLabel: 'Laufende Workspaces',
  noProfiles: 'Noch keine Profile.',
  noWorkspaces: 'Keine aktiven Workspaces.',
  newProfile: '+ Neues Profil',
  newProfileTitle: 'Neues Profil anlegen',
  startWorkspace: (profile: string): string => `Workspace für „${profile}" starten`,
  editProfile: (profile: string): string => `Profil „${profile}" bearbeiten`,
  stopWorkspace: (workspace: string): string => `Workspace „${workspace}" beenden`,
  agentCount: (count: number): string => `${count} ${count === 1 ? 'Agent' : 'Agenten'}`,
  agentWorking: 'arbeitet',
  agentWaiting: 'wartet',
  agentStopped: 'beendet',
  openQuestion: 'Offene Frage',
  focusAgent: (agent: string): string => `Fenster von ${agent} nach vorn holen`,
  yolo: 'Yolo',
  yoloOn: 'Yolo-Master ist AN — Subagents dürfen ohne Rückfrage handeln',
  yoloOff: 'Yolo-Master ist AUS — Subagents fragen nach',
  hideAll: 'Alles ausblenden',
  quit: 'Vertragus beenden',
  settings: 'Einstellungen',
  /**
   * The settings button is honest instead of dead: it is clickable and says
   * what is missing. A greyed-out gear with a "coming in M6" tooltip reads as
   * broken — that is exactly how the second test run reported it.
   */
  settingsHint: 'Einstellungen kommen mit M6 — Hotkey & Co. bis dahin über die Konfig-Datei.',
  bridgeMissing: 'Preload-Bridge nicht verfügbar.',
  loading: 'lädt …'
} as const
