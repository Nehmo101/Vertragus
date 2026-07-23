/**
 * Slice interfaces for the central renderer store. The combined `AppState`
 * remains a single zustand store (see ../useAppStore.ts); these interfaces
 * only partition the state/actions per domain so each slice creator stays
 * cohesive. Cross-domain writes stay legal: every slice creator is typed as
 * `StateCreator<AppState, [], [], XSlice>` and may set fields of any slice.
 */
import type { AgentInstanceInfo, BulkHandoffRequest, HandoffRequest, VertragusEvent } from '@shared/agents'
import type {
  AgentProviderId,
  DisabledModels,
  ProviderEnabled,
  ProviderHealth,
  ProviderId
} from '@shared/providers'
import type { WorkspaceProfile } from '@shared/profile'
import type { McpServerConfig } from '@shared/mcp'
import type { OrchestratorSnapshot, WorkspaceSessionSummary } from '@shared/orchestrator'
import type { AppInfo, GitInfo, GithubAuthStatus } from '@shared/ipc'
import type { VoiceUiCommand } from '@shared/voiceAssistant'
import type { RepoRef } from '@shared/repoSwitcher'
import type { ModelCatalog } from '@renderer/modelCatalog'
// Type-only circular import: erased at compile time, so no runtime cycle.
import type { ManualAgentSelection, UiDensity, UiTheme, WorkspaceLayout } from '../useAppStore'

export interface ProvidersSlice {
  health: ProviderHealth[]
  models: ModelCatalog
  /** Per-provider Vertragus process gates shown live in the Limits panel. */
  providerLimits: Record<AgentProviderId, number>
  providerEnabled: ProviderEnabled
  disabledModels: DisabledModels

  refreshHealth(): Promise<void>
  refreshModels(): Promise<void>
  loginProvider(id: ProviderId): Promise<void>
  setProviderLimit(provider: AgentProviderId, value: number): void
  setProviderEnabled(provider: AgentProviderId, enabled: boolean): void
  setModelEnabled(provider: AgentProviderId, model: string, enabled: boolean): void
}

export interface ProfilesSlice {
  profiles: WorkspaceProfile[]
  activeProfileId: string
  workspaceSessions: WorkspaceSessionSummary[]
  activeWorkspaceSessionId: string | null
  /** Profile being edited in the modal; null = closed. */
  editorProfile: WorkspaceProfile | null

  selectProfile(id: string): Promise<boolean>
  selectWorkspaceSession(profileId: string, sessionId: string): Promise<boolean>
  removeWorkspaceSession(profileId: string, sessionId: string): Promise<void>
  openEditor(profile: WorkspaceProfile): void
  openEditorNew(): void
  closeEditor(): void
  saveEditor(profile: WorkspaceProfile): Promise<void>
  duplicateProfile(id: string): Promise<void>
  deleteProfile(id: string): Promise<void>
}

export interface GitRepoSlice {
  /** Soft app-level repository override; null = follow the active profile. */
  activeRepo: RepoRef | null
  /** Manually added repositories, most recent first. */
  recentRepos: RepoRef[]
  gitInfo: GitInfo | null
  githubAuth: GithubAuthStatus | null
  githubAuthBusy: boolean

  refreshGithubAuth(): Promise<void>
  githubLogin(): Promise<void>
  githubLogout(): Promise<void>
  githubTerminalLogin(): Promise<void>
  refreshGit(): Promise<void>
  switchGitBranch(branch: string): Promise<boolean>
  /** Switch the active repository (null = follow the active profile default). */
  selectRepo(ref: RepoRef | null): Promise<void>
  /** Pick a folder from disk and switch the active repository to it. */
  addRepoFromFolder(): Promise<void>
}

export interface AgentsSlice {
  agents: AgentInstanceInfo[]
  events: VertragusEvent[]
  selectedAgentId: string | null
  /** Finished subagents explicitly reopened from the sidebar history. */
  reopenedAgentIds: string[]
  /** Source agent for the handoff modal; null = closed. */
  handoffSource: AgentInstanceInfo | null
  /** Pre-select the bulk checkbox when the handoff modal opens (Massenübergabe entry). */
  handoffBulk: boolean
  addAgentOpen: boolean
  addSeq: number

  setSelectedAgent(id: string | null): void
  reopenAgent(id: string): void
  hideAgent(id: string): void
  startAll(): Promise<string | void>
  stopAll(): Promise<void>
  cleanWorkspace(): Promise<void>
  openAddAgent(): void
  closeAddAgent(): void
  addAgent(selection: ManualAgentSelection): Promise<boolean>
  killAgent(id: string): Promise<void>
  popout(id: string): Promise<void>
  openHandoff(id: string, opts?: { bulk?: boolean }): void
  closeHandoff(): void
  handoff(req: HandoffRequest): Promise<void>
  bulkHandoff(req: BulkHandoffRequest): Promise<void>
}

export interface OrchestratorSlice {
  orchestrator: OrchestratorSnapshot
  orchestrators: Record<string, OrchestratorSnapshot>
  yoloMaster: boolean

  toggleYolo(): void
  reviewPendingPlan(approved: boolean): Promise<void>
}

export interface UiSlice {
  appInfo: AppInfo | null
  theme: UiTheme
  workspaceLayout: WorkspaceLayout
  uiDensity: UiDensity
  /** Global default: CLI panes show a readable activity summary instead of raw output. */
  cliReadable: boolean
  /** Per-agent overrides of the global readable default (session-scoped). */
  paneReadable: Record<string, boolean>
  toast: string | null
  /** User-configured external MCP servers attached to the launched agents. */
  mcpServers: McpServerConfig[]
  /** True while the MCP-server manager modal is open. */
  mcpEditorOpen: boolean
  /** True while the global speech-to-text settings modal is open. */
  speechSettingsOpen: boolean
  /** Bumped whenever STT settings are saved so status consumers refetch. */
  speechStatusRevision: number

  toggleTheme(): void
  /** Flip the global default for readable CLI panes and persist it. */
  toggleCliReadable(): void
  /** Override the readable/raw mode for a single pane (relative to the current effective value). */
  togglePaneReadable(agentId: string): void
  setWorkspaceLayout(layout: WorkspaceLayout): void
  setUiDensity(density: UiDensity): void
  showToast(msg: string): void
  exportDiagnostics(): Promise<void>
  /** Apply a voice-assistant UI navigation command (layout/view/session). */
  applyUiCommand(command: VoiceUiCommand): void
  openMcpEditor(): void
  closeMcpEditor(): void
  saveMcpServers(servers: McpServerConfig[]): Promise<void>
  openSpeechSettings(): void
  closeSpeechSettings(): void
  bumpSpeechStatus(): void
}

/** The one-time bootstrap; implemented in useAppStore.ts (source-text contract). */
export interface InitSlice {
  init(): Promise<void>
}

export type AppState = ProvidersSlice &
  ProfilesSlice &
  GitRepoSlice &
  AgentsSlice &
  OrchestratorSlice &
  UiSlice &
  InitSlice
