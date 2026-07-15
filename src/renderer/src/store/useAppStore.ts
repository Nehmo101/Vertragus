/**
 * Central renderer state (zustand), wired to the real main-process API.
 */
import { create } from 'zustand'
import type { AgentInstanceInfo, HandoffRequest, OrcaEvent } from '@shared/agents'
import { LIMIT_KIND_LABELS } from '@shared/agents'
import type {
  AgentProviderId,
  DisabledModels,
  ProviderEnabled,
  ProviderHealth,
  ProviderId
} from '@shared/providers'
import {
  DEFAULT_DISABLED_MODELS,
  DEFAULT_MODELS,
  DEFAULT_PROVIDER_ENABLED,
  DEFAULT_PROVIDER_LIMITS,
  normalizeDisabledModels,
  normalizeProviderEnabled,
  normalizeProviderLimits
} from '@shared/providers'
import type { WorkspaceProfile } from '@shared/profile'
import type { McpServerConfig } from '@shared/mcp'
import type { OrchestratorSnapshot, WorkspaceSessionSummary } from '@shared/orchestrator'
import type { AppInfo, GitInfo, GithubAuthStatus } from '@shared/ipc'
import {
  collectKnownRepos,
  parseActiveRepo,
  parseRecentRepos,
  profileRepoRef,
  repoRefKey,
  resolveActiveRepoPath,
  type RepoRef
} from '@shared/repoSwitcher'
import { normalizeModelCatalog, type ModelCatalog } from '@renderer/modelCatalog'
import type { ModelPreset } from '@shared/models'
import { middleEarthWorkspaceName } from '@shared/workspaceNames'

const ADD_ROLES = ['Docs / Changelog', 'Refactor / Cleanup', 'Security-Review', 'Perf / Bench']

export interface ManualAgentSelection {
  provider: AgentProviderId
  model: string
  modelPreset?: ModelPreset
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export type UiTheme = 'light' | 'dark'
export type WorkspaceLayout = 'tiles' | 'focus' | 'dag'
export type UiDensity = 'comfortable' | 'compact'

interface AppState {
  appInfo: AppInfo | null
  health: ProviderHealth[]
  models: ModelCatalog
  /** Per-provider Orca process gates shown live in the Limits panel. */
  providerLimits: Record<AgentProviderId, number>
  providerEnabled: ProviderEnabled
  disabledModels: DisabledModels
  profiles: WorkspaceProfile[]
  activeProfileId: string
  /** Soft app-level repository override; null = follow the active profile. */
  activeRepo: RepoRef | null
  /** Manually added repositories, most recent first. */
  recentRepos: RepoRef[]
  workspaceSessions: WorkspaceSessionSummary[]
  activeWorkspaceSessionId: string | null
  /** User-configured external MCP servers attached to the launched agents. */
  mcpServers: McpServerConfig[]
  /** True while the MCP-server manager modal is open. */
  mcpEditorOpen: boolean
  /** True while the global speech-to-text settings modal is open. */
  speechSettingsOpen: boolean
  /** Bumped whenever STT settings are saved so status consumers refetch. */
  speechStatusRevision: number
  gitInfo: GitInfo | null
  githubAuth: GithubAuthStatus | null
  githubAuthBusy: boolean
  agents: AgentInstanceInfo[]
  events: OrcaEvent[]
  orchestrator: OrchestratorSnapshot
  orchestrators: Record<string, OrchestratorSnapshot>
  selectedAgentId: string | null
  /** Finished subagents explicitly reopened from the sidebar history. */
  reopenedAgentIds: string[]
  yoloMaster: boolean
  theme: UiTheme
  workspaceLayout: WorkspaceLayout
  uiDensity: UiDensity
  /** Global default: CLI panes show a readable activity summary instead of raw output. */
  cliReadable: boolean
  /** Per-agent overrides of the global readable default (session-scoped). */
  paneReadable: Record<string, boolean>
  toast: string | null
  /** Profile being edited in the modal; null = closed. */
  editorProfile: WorkspaceProfile | null
  /** Source agent for the handoff modal; null = closed. */
  handoffSource: AgentInstanceInfo | null
  addAgentOpen: boolean
  addSeq: number

  init(): Promise<void>
  refreshHealth(): Promise<void>
  refreshModels(): Promise<void>
  refreshGithubAuth(): Promise<void>
  githubLogin(): Promise<void>
  githubLogout(): Promise<void>
  githubTerminalLogin(): Promise<void>
  loginProvider(id: ProviderId): Promise<void>
  refreshGit(): Promise<void>
  switchGitBranch(branch: string): Promise<boolean>
  /** Switch the active repository (null = follow the active profile default). */
  selectRepo(ref: RepoRef | null): Promise<void>
  /** Pick a folder from disk and switch the active repository to it. */
  addRepoFromFolder(): Promise<void>
  selectProfile(id: string): Promise<boolean>
  selectWorkspaceSession(profileId: string, sessionId: string): Promise<boolean>
  removeWorkspaceSession(profileId: string, sessionId: string): Promise<void>
  setProviderLimit(provider: AgentProviderId, value: number): void
  setProviderEnabled(provider: AgentProviderId, enabled: boolean): void
  setModelEnabled(provider: AgentProviderId, model: string, enabled: boolean): void
  toggleYolo(): void
  toggleTheme(): void
  /** Flip the global default for readable CLI panes and persist it. */
  toggleCliReadable(): void
  /** Override the readable/raw mode for a single pane (relative to the current effective value). */
  togglePaneReadable(agentId: string): void
  setWorkspaceLayout(layout: WorkspaceLayout): void
  setUiDensity(density: UiDensity): void
  showToast(msg: string): void
  exportDiagnostics(): Promise<void>
  setSelectedAgent(id: string | null): void
  reopenAgent(id: string): void
  hideAgent(id: string): void
  startAll(): Promise<void>
  stopAll(): Promise<void>
  cleanWorkspace(): Promise<void>
  reviewPendingPlan(approved: boolean): Promise<void>
  openAddAgent(): void
  closeAddAgent(): void
  addAgent(selection: ManualAgentSelection): Promise<boolean>
  killAgent(id: string): Promise<void>
  popout(id: string): Promise<void>
  openHandoff(id: string): void
  closeHandoff(): void
  handoff(req: HandoffRequest): Promise<void>
  openEditor(profile: WorkspaceProfile): void
  openEditorCopy(profile: WorkspaceProfile): void
  openEditorNew(): void
  closeEditor(): void
  saveEditor(profile: WorkspaceProfile): Promise<void>
  deleteProfile(id: string): Promise<void>
  openMcpEditor(): void
  closeMcpEditor(): void
  saveMcpServers(servers: McpServerConfig[]): Promise<void>
  openSpeechSettings(): void
  closeSpeechSettings(): void
  bumpSpeechStatus(): void
}

let toastTimer: ReturnType<typeof setTimeout> | undefined
let initialized = false
let githubAuthRequest = 0
let githubAuthAction = 0
let modelRefreshSequence = 0

export function activeProfile(s: Pick<AppState, 'profiles' | 'activeProfileId'>):
  | WorkspaceProfile
  | undefined {
  return s.profiles.find((p) => p.id === s.activeProfileId)
}

type RepoState = Pick<AppState, 'profiles' | 'activeProfileId' | 'activeRepo' | 'recentRepos'>

/** The effective repository: explicit override, else the active profile default. */
export function effectiveRepoRef(s: RepoState): RepoRef | null {
  if (s.activeRepo?.path?.trim()) return s.activeRepo
  const profile = activeProfile(s)
  return profile ? profileRepoRef(profile) : null
}

/** Effective repository working directory ('' when none is selected). */
export function effectiveRepoPath(s: RepoState): string {
  return resolveActiveRepoPath(s.activeRepo, activeProfile(s))
}

/** Ordered pick list for the title-bar repository switcher. */
export function knownRepos(s: RepoState): RepoRef[] {
  return collectKnownRepos(s.profiles, s.recentRepos, effectiveRepoRef(s))
}

export function workspaceAgents(
  state: Pick<AppState, 'agents' | 'activeProfileId'> &
    Partial<Pick<AppState, 'activeWorkspaceSessionId'>>
): AgentInstanceInfo[] {
  return state.agents.filter(
    (agent) =>
      (!agent.profileId || agent.profileId === state.activeProfileId) &&
      (!state.activeWorkspaceSessionId || agent.workspaceSessionId === state.activeWorkspaceSessionId)
  )
}

export function isFinishedSubagent(agent: AgentInstanceInfo): boolean {
  return agent.kind === 'sub' && (agent.status === 'stopped' || agent.status === 'error')
}

/** Whether a pane shows the readable summary: its own override, else the global default. */
export function effectivePaneReadable(
  state: Pick<AppState, 'cliReadable' | 'paneReadable'>,
  agentId: string
): boolean {
  return state.paneReadable[agentId] ?? state.cliReadable
}

export function workspaceAgentHistory(
  state: Pick<AppState, 'agents' | 'activeProfileId'> &
    Partial<Pick<AppState, 'activeWorkspaceSessionId'>>
): AgentInstanceInfo[] {
  return workspaceAgents(state)
    .filter((agent) => agent.profileId === state.activeProfileId && isFinishedSubagent(agent))
    .sort((a, b) => b.startedAt - a.startedAt)
}

export function visibleWorkspaceAgents(
  state: Pick<AppState, 'agents' | 'activeProfileId' | 'reopenedAgentIds'> &
    Partial<Pick<AppState, 'activeWorkspaceSessionId'>>
): AgentInstanceInfo[] {
  const reopened = new Set(state.reopenedAgentIds)
  return workspaceAgents(state).filter(
    (agent) => !isFinishedSubagent(agent) || reopened.has(agent.id)
  )
}

export function workspaceEvents(
  state: Pick<AppState, 'events' | 'activeProfileId'> &
    Partial<Pick<AppState, 'activeWorkspaceSessionId'>>
): OrcaEvent[] {
  return state.events.filter(
    (event) =>
      (!event.profileId || event.profileId === state.activeProfileId) &&
      (!state.activeWorkspaceSessionId || event.workspaceSessionId === state.activeWorkspaceSessionId)
  )
}

export const useAppStore = create<AppState>((set, get) => ({
  appInfo: null,
  health: [],
  models: normalizeModelCatalog(DEFAULT_MODELS),
  providerLimits: DEFAULT_PROVIDER_LIMITS,
  providerEnabled: DEFAULT_PROVIDER_ENABLED,
  disabledModels: DEFAULT_DISABLED_MODELS,
  profiles: [],
  activeProfileId: '',
  activeRepo: null,
  recentRepos: [],
  workspaceSessions: [],
  activeWorkspaceSessionId: null,
  mcpServers: [],
  mcpEditorOpen: false,
  speechSettingsOpen: false,
  speechStatusRevision: 0,
  gitInfo: null,
  githubAuth: null,
  githubAuthBusy: false,
  agents: [],
  events: [],
  orchestrator: { goal: null, tasks: [] },
  orchestrators: {},
  selectedAgentId: null,
  reopenedAgentIds: [],
  yoloMaster: false,
  theme: 'light',
  workspaceLayout: 'tiles',
  uiDensity: 'comfortable',
  cliReadable: false,
  paneReadable: {},
  toast: null,
  editorProfile: null,
  handoffSource: null,
  addAgentOpen: false,
  addSeq: 0,

  async init() {
    if (initialized) return
    initialized = true

    window.orca.agents.onChanged((agents) => {
      // Surface a toast the first time an agent trips a usage-limit signal.
      const prev = get().agents
      for (const a of agents) {
        if (!a.limitWarning) continue
        const before = prev.find((p) => p.id === a.id)
        if (before?.limitWarning) continue
        const label = LIMIT_KIND_LABELS[a.limitWarning.kind]
        get().showToast(`⚠ ${a.name}: ${label} nahe — „⇄ Übergeben" möglich`)
      }
      const retainedIds = new Set(agents.map((agent) => agent.id))
      set((state) => ({
        agents,
        reopenedAgentIds: state.reopenedAgentIds.filter((id) => retainedIds.has(id)),
        paneReadable: Object.fromEntries(
          Object.entries(state.paneReadable).filter(([id]) => retainedIds.has(id))
        )
      }))
    })
    window.orca.agents.onEvent((evt) =>
      set((s) => ({ events: [...s.events.slice(-199), evt] }))
    )
    window.orca.onProvidersChanged((health) => {
      set({ health })
      // The account-visible catalogue may change when the interactive login closes.
      void get().refreshModels()
      if (health.some((provider) => provider.id === 'github')) void get().refreshGithubAuth()
    })
    window.orca.workspaceSessions.onChanged((workspaceSessions) =>
      set((state) => {
        const currentStillExists = workspaceSessions.some(
          (session) => session.id === state.activeWorkspaceSessionId
        )
        const active = workspaceSessions.find(
          (session) => session.profileId === state.activeProfileId && session.active
        )
        const activeWorkspaceSessionId = active?.id ?? (
          currentStillExists ? state.activeWorkspaceSessionId : null
        )
        const cachedSnapshot = activeWorkspaceSessionId
          ? state.orchestrators[activeWorkspaceSessionId]
          : undefined
        return {
          workspaceSessions,
          activeWorkspaceSessionId,
          ...(cachedSnapshot ? { orchestrator: cachedSnapshot } : {})
        }
      })
    )
    window.orca.orchestrator.onSnapshot((snap) =>
      set((state) => {
        const profileId = snap.profileId
        if (!profileId) return { orchestrator: snap }
        const key = snap.workspaceSessionId ?? profileId
        const orchestrators = { ...state.orchestrators, [key]: snap }
        const isActive =
          profileId === state.activeProfileId &&
          (!state.activeWorkspaceSessionId || snap.workspaceSessionId === state.activeWorkspaceSessionId)
        return isActive
          ? { orchestrators, orchestrator: snap }
          : { orchestrators }
      })
    )

    const [
      appInfo,
      profiles,
      activeProfileId,
      mcpServers,
      agents,
      yolo,
      snapshot,
      theme,
      layout,
      density,
      limits,
      workspaceSessions,
      providerEnabled,
      disabledModels,
      cliReadable,
      activeRepoRaw,
      recentReposRaw
    ] =
      await Promise.all([
        window.orca.getAppInfo(),
        window.orca.listProfiles(),
        window.orca.getActiveProfileId(),
        window.orca.listMcpServers(),
        window.orca.agents.list(),
        window.orca.getConfig<boolean>('yoloMaster'),
        window.orca.getActiveProfileId().then((profileId) =>
          window.orca.orchestrator.snapshot(profileId)),
        window.orca.getConfig<UiTheme>('ui.theme'),
        window.orca.getConfig<WorkspaceLayout>('ui.workspaceLayout'),
        window.orca.getConfig<UiDensity>('ui.density'),
        window.orca.getConfig<Partial<Record<AgentProviderId, number>>>('providerLimits'),
        window.orca.workspaceSessions.list(),
        window.orca.getConfig<Partial<ProviderEnabled>>('providerEnabled'),
        window.orca.getConfig<Partial<DisabledModels>>('disabledModels'),
        window.orca.getConfig<boolean>('ui.cliReadable'),
        window.orca.getConfig<unknown>('workspaceRepo.active'),
        window.orca.getConfig<unknown>('workspaceRepo.recent')
      ])
    set({
      appInfo,
      profiles,
      activeProfileId,
      activeRepo: parseActiveRepo(activeRepoRaw),
      recentRepos: parseRecentRepos(recentReposRaw),
      workspaceSessions,
      activeWorkspaceSessionId:
        snapshot.workspaceSessionId ??
        workspaceSessions.find((session) => session.profileId === activeProfileId && session.active)?.id ??
        null,
      mcpServers,
      agents,
      yoloMaster: yolo ?? false,
      orchestrator: snapshot,
      orchestrators: { [snapshot.workspaceSessionId ?? activeProfileId]: snapshot },
      theme: theme === 'dark' ? 'dark' : 'light',
      workspaceLayout: layout === 'focus' || layout === 'dag' ? layout : 'tiles',
      uiDensity: density === 'compact' ? density : 'comfortable',
      cliReadable: cliReadable ?? false,
      providerLimits: normalizeProviderLimits(limits),
      providerEnabled: normalizeProviderEnabled(providerEnabled),
      disabledModels: normalizeDisabledModels(disabledModels)
    })

    void get().refreshGit()
    void get().refreshHealth()
    void get().refreshGithubAuth()
    void get().refreshModels()
  },

  async refreshGithubAuth() {
    const request = ++githubAuthRequest
    try {
      const githubAuth = await window.orca.githubAuthStatus()
      if (request === githubAuthRequest) set({ githubAuth })
    } catch (error) {
      // Do not keep displaying an old authenticated session when its status
      // can no longer be verified.
      if (request === githubAuthRequest) {
        set({ githubAuth: null })
        get().showToast(`GitHub-Status nicht verfügbar: ${errorMessage(error)}`)
      }
    }
  },

  async githubLogin() {
    if (get().githubAuthBusy) return
    const action = ++githubAuthAction
    const request = ++githubAuthRequest
    set({ githubAuthBusy: true })
    try {
      const githubAuth = await window.orca.githubAuthLogin()
      if (request === githubAuthRequest) set({ githubAuth })
      void get().refreshHealth()
      get().showToast(
        githubAuth.needsReauth
          ? `GitHub-Berechtigungen fehlen: ${githubAuth.missingScopes.join(', ')}.`
          : githubAuth.authenticated
            ? `GitHub verbunden${githubAuth.account ? ` als ${githubAuth.account}` : ''}.`
            : 'GitHub-Anmeldung unvollständig.'
      )
    } catch (error) {
      get().showToast(`GitHub-Login fehlgeschlagen: ${errorMessage(error)}`)
      if (action === githubAuthAction) set({ githubAuthBusy: false })
      await get().refreshGithubAuth()
    } finally {
      if (action === githubAuthAction) set({ githubAuthBusy: false })
    }
  },

  async githubLogout() {
    if (get().githubAuthBusy) return
    const action = ++githubAuthAction
    const request = ++githubAuthRequest
    set({ githubAuthBusy: true })
    try {
      const githubAuth = await window.orca.githubAuthLogout()
      if (request === githubAuthRequest) set({ githubAuth })
      void get().refreshHealth()
      get().showToast('GitHub abgemeldet.')
    } catch (error) {
      get().showToast(`GitHub-Abmeldung fehlgeschlagen: ${errorMessage(error)}`)
      if (action === githubAuthAction) set({ githubAuthBusy: false })
      await get().refreshGithubAuth()
    } finally {
      if (action === githubAuthAction) set({ githubAuthBusy: false })
    }
  },

  async githubTerminalLogin() {
    await get().loginProvider('github')
  },

  async refreshHealth() {
    try {
      const health = await window.orca.checkProviders()
      set({ health })
      if (health.some((provider) => provider.id === 'github')) void get().refreshGithubAuth()
    } finally {
      // The sidebar refresh is also an explicit refresh of model suggestions.
      await get().refreshModels()
    }
  },

  async refreshModels() {
    const sequence = ++modelRefreshSequence
    try {
      const models = await window.orca.listModels()
      if (sequence !== modelRefreshSequence) return
      set({ models: normalizeModelCatalog(models) })
    } catch {
      // Never retain another account's last live catalogue after logout or a
      // failed refresh. Fall back to explicitly unverified local suggestions.
      if (sequence === modelRefreshSequence) set({ models: normalizeModelCatalog(DEFAULT_MODELS) })
    }
  },

  async loginProvider(id) {
    const provider = get().health.find((item) => item.id === id)
    if (!provider?.available || !provider.canLogin) return
    try {
      await window.orca.loginProvider(id)
      // The completion event triggers a second reload after the CLI closes.
      void get().refreshModels()
      get().showToast(`${provider.loginLabel ?? 'Provider-Login'} im sicheren Terminal geöffnet.`)
    } catch (error) {
      get().showToast(`Login konnte nicht gestartet werden: ${errorMessage(error)}`)
    }
  },

  async refreshGit() {
    const dir = effectiveRepoPath(get())
    const gitInfo = dir ? await window.orca.gitInfo(dir) : { isRepo: false }
    set({ gitInfo })
  },

  async switchGitBranch(branch) {
    const dir = effectiveRepoPath(get())
    if (!dir) return false

    try {
      const gitInfo = await window.orca.gitSwitchBranch(dir, branch)
      set({ gitInfo })
      get().showToast(`Branch gewechselt: ${gitInfo.branch ?? branch}`)
      return true
    } catch (error) {
      get().showToast(`Branch konnte nicht gewechselt werden: ${errorMessage(error)}`)
      await get().refreshGit().catch(() => undefined)
      return false
    }
  },

  async selectRepo(ref) {
    const previous = get().activeRepo
    if (ref && !ref.path.trim()) return

    const previousRecents = get().recentRepos
    let recentRepos = previousRecents
    if (ref) {
      const key = repoRefKey(ref.path)
      const fromProfile = get().profiles.some((profile) => {
        const profileRef = profileRepoRef(profile)
        return profileRef ? repoRefKey(profileRef.path) === key : false
      })
      // Only manually chosen folders are remembered; profile repos already list.
      if (!fromProfile) {
        recentRepos = [
          ref,
          ...previousRecents.filter((entry) => repoRefKey(entry.path) !== key)
        ].slice(0, 12)
      }
    }
    const recentsChanged = recentRepos !== previousRecents

    set({ activeRepo: ref, recentRepos })
    try {
      // Await the persist so the main process reads the same override before a
      // subsequent team start resolves its working directory.
      await window.orca.setConfig('workspaceRepo.active', ref)
      if (recentsChanged) void window.orca.setConfig('workspaceRepo.recent', recentRepos)
    } catch (error) {
      set({ activeRepo: previous, recentRepos: previousRecents })
      get().showToast(`Repository konnte nicht gewechselt werden: ${errorMessage(error)}`)
      return
    }

    await get().refreshGit().catch((error) => {
      get().showToast(`Git-Status nicht verfügbar: ${errorMessage(error)}`)
    })
    const path = effectiveRepoPath(get())
    get().showToast(
      ref
        ? `Repository gewechselt: ${ref.label?.trim() || path || ref.path}`
        : 'Repository folgt wieder dem aktiven Profil.'
    )
  },

  async addRepoFromFolder() {
    const dir = await window.orca.pickFolder()
    if (!dir) return
    await get().selectRepo({ path: dir })
  },

  async selectProfile(id) {
    if (id === get().activeProfileId) {
      await get().refreshGit().catch((error) => {
        get().showToast(`Git-Status nicht verfügbar: ${errorMessage(error)}`)
      })
      return true
    }
    try {
      await window.orca.setActiveProfileId(id)
      const workspaceSessions = await window.orca.workspaceSessions.list()
      const activeSession = workspaceSessions.find(
        (session) => session.profileId === id && session.active
      )
      const snapshot = await window.orca.orchestrator.snapshot(id, activeSession?.id)
      set((state) => ({
        activeProfileId: id,
        workspaceSessions,
        activeWorkspaceSessionId: activeSession?.id ?? null,
        orchestrator: snapshot,
        orchestrators: {
          ...state.orchestrators,
          [snapshot.workspaceSessionId ?? id]: snapshot
        }
      }))
      await get().refreshGit().catch((error) => {
        get().showToast(`Profil gewechselt, Git-Status nicht verfügbar: ${errorMessage(error)}`)
      })
      return true
    } catch (error) {
      get().showToast(`Profilwechsel nicht möglich: ${errorMessage(error)}`)
      return false
    }
  },

  async selectWorkspaceSession(profileId, sessionId) {
    try {
      if (profileId !== get().activeProfileId) {
        await window.orca.setActiveProfileId(profileId)
      }
      const snapshot = await window.orca.workspaceSessions.setActive(profileId, sessionId)
      const workspaceSessions = await window.orca.workspaceSessions.list()
      set((state) => ({
        activeProfileId: profileId,
        activeWorkspaceSessionId: sessionId,
        workspaceSessions,
        orchestrator: snapshot,
        orchestrators: { ...state.orchestrators, [sessionId]: snapshot },
        selectedAgentId: null
      }))
      await get().refreshGit().catch(() => undefined)
      return true
    } catch (error) {
      get().showToast(`Workspace konnte nicht ausgewaehlt werden: ${errorMessage(error)}`)
      return false
    }
  },

  async removeWorkspaceSession(profileId, sessionId) {
    try {
      const workspaceSessions = await window.orca.workspaceSessions.remove(profileId, sessionId)
      const activeSession = workspaceSessions.find(
        (session) => session.profileId === profileId && session.active
      )
      const snapshot = await window.orca.orchestrator.snapshot(profileId, activeSession?.id)
      set((state) => ({
        workspaceSessions,
        activeWorkspaceSessionId: activeSession?.id ?? null,
        orchestrator: snapshot,
        orchestrators: {
          ...state.orchestrators,
          [snapshot.workspaceSessionId ?? profileId]: snapshot
        },
        selectedAgentId: null
      }))
      get().showToast('Workspace-Lauf entfernt.')
    } catch (error) {
      get().showToast(`Workspace konnte nicht entfernt werden: ${errorMessage(error)}`)
    }
  },

  setProviderLimit(provider, value) {
    const providerLimits = normalizeProviderLimits({ ...get().providerLimits, [provider]: value })
    set({ providerLimits })
    void window.orca.setConfig('providerLimits', providerLimits)
  },

  setProviderEnabled(provider, enabled) {
    const providerEnabled = normalizeProviderEnabled({
      ...get().providerEnabled,
      [provider]: enabled
    })
    set({ providerEnabled })
    void window.orca.setConfig('providerEnabled', providerEnabled)
  },

  setModelEnabled(provider, model, enabled) {
    const normalized = model.trim()
    if (!normalized) return
    const current = get().disabledModels[provider]
    const disabled = enabled
      ? current.filter((entry) => entry.toLowerCase() !== normalized.toLowerCase())
      : [...current.filter((entry) => entry.toLowerCase() !== normalized.toLowerCase()), normalized]
    const disabledModels = normalizeDisabledModels({
      ...get().disabledModels,
      [provider]: disabled
    })
    set({ disabledModels })
    void window.orca.setConfig('disabledModels', disabledModels)
  },

  toggleYolo() {
    const next = !get().yoloMaster
    set({ yoloMaster: next })
    void window.orca.setConfig('yoloMaster', next)
  },

  toggleTheme() {
    const next = get().theme === 'light' ? 'dark' : 'light'
    set({ theme: next })
    void window.orca.setConfig('ui.theme', next)
  },

  toggleCliReadable() {
    const next = !get().cliReadable
    set({ cliReadable: next })
    void window.orca.setConfig('ui.cliReadable', next)
  },

  togglePaneReadable(agentId) {
    set((state) => ({
      paneReadable: {
        ...state.paneReadable,
        [agentId]: !effectivePaneReadable(state, agentId)
      }
    }))
  },

  setWorkspaceLayout(layout) {
    set({ workspaceLayout: layout })
    void window.orca.setConfig('ui.workspaceLayout', layout)
  },

  setUiDensity(density) {
    set({ uiDensity: density })
    void window.orca.setConfig('ui.density', density)
  },

  showToast(msg) {
    set({ toast: msg })
    clearTimeout(toastTimer)
    toastTimer = setTimeout(() => set({ toast: null }), 2600)
  },

  async exportDiagnostics() {
    try {
      const path = await window.orca.diagnostics.exportLatest(get().activeProfileId)
      get().showToast(
        path ? `Diagnose exportiert: ${path}` : 'Für dieses Workspace-Profil gibt es noch keinen Run.'
      )
    } catch (error) {
      get().showToast(`Diagnoseexport fehlgeschlagen: ${errorMessage(error)}`)
    }
  },

  setSelectedAgent(id) {
    set({ selectedAgentId: id })
  },

  reopenAgent(id) {
    if (!get().agents.some((agent) => agent.id === id)) return
    set((state) => ({
      reopenedAgentIds: state.reopenedAgentIds.includes(id)
        ? state.reopenedAgentIds
        : [...state.reopenedAgentIds, id],
      selectedAgentId: id
    }))
  },

  hideAgent(id) {
    set((state) => ({
      reopenedAgentIds: state.reopenedAgentIds.filter((agentId) => agentId !== id),
      selectedAgentId: state.selectedAgentId === id ? null : state.selectedAgentId
    }))
  },

  async startAll() {
    const s = get()
    const profile = activeProfile(s)
    if (!profile) {
      s.showToast('Kein Workspace-Profil ausgewählt.')
      return
    }
    s.showToast(`Workspace „${profile.name}" startet…`)
    try {
      const spawned = await window.orca.agents.spawnProfile(profile.id, s.yoloMaster)
      const workspaceSessionId = spawned.find((agent) => agent.workspaceSessionId)?.workspaceSessionId
      if (workspaceSessionId) {
        const [workspaceSessions, snapshot] = await Promise.all([
          window.orca.workspaceSessions.list(),
          window.orca.orchestrator.snapshot(profile.id, workspaceSessionId)
        ])
        set((state) => ({
          workspaceSessions,
          activeWorkspaceSessionId: workspaceSessionId,
          orchestrator: snapshot,
          orchestrators: { ...state.orchestrators, [workspaceSessionId]: snapshot },
          selectedAgentId: null
        }))
        const startedSession = workspaceSessions.find((item) => item.id === workspaceSessionId)
        if (startedSession) {
          const name = startedSession.name || middleEarthWorkspaceName(startedSession.sequence)
          get().showToast(`W${startedSession.sequence} ${name} gestartet.`)
        } else {
          get().showToast('Workspace gestartet.')
        }
      }
    } catch (error) {
      get().showToast(`Workspace konnte nicht starten: ${errorMessage(error)}`)
    }
  },

  async stopAll() {
    await window.orca.agents.killAll()
    get().showToast('Alle Agents gestoppt.')
  },

  async cleanWorkspace() {
    await window.orca.agents.clean(
      get().activeProfileId,
      get().activeWorkspaceSessionId ?? undefined
    )
    const workspaceSessions = await window.orca.workspaceSessions.list()
    const activeSession = workspaceSessions.find(
      (session) => session.profileId === get().activeProfileId && session.active
    )
    const snapshot = await window.orca.orchestrator.snapshot(
      get().activeProfileId,
      activeSession?.id
    )
    set((state) => ({
      workspaceSessions,
      activeWorkspaceSessionId: activeSession?.id ?? null,
      orchestrator: snapshot,
      orchestrators: {
        ...state.orchestrators,
        [snapshot.workspaceSessionId ?? get().activeProfileId]: snapshot
      },
      selectedAgentId: null
    }))
    get().showToast('Workspace geleert — alle Agents entfernt.')
  },

  async reviewPendingPlan(approved) {
    const state = get()
    const workspaceSessionId = state.activeWorkspaceSessionId ?? undefined
    try {
      const resolved = await window.orca.orchestrator.reviewPlan(
        state.activeProfileId,
        approved,
        workspaceSessionId
      )
      if (!resolved) {
        state.showToast('Kein Plan wartet mehr auf Freigabe.')
        return
      }
      const snapshot = await window.orca.orchestrator.snapshot(
        state.activeProfileId,
        workspaceSessionId
      )
      set((current) => ({
        orchestrator: snapshot,
        orchestrators: {
          ...current.orchestrators,
          [snapshot.workspaceSessionId ?? state.activeProfileId]: snapshot
        }
      }))
      get().showToast(approved ? 'Plan freigegeben.' : 'Plan abgelehnt.')
    } catch (error) {
      state.showToast(`Planfreigabe fehlgeschlagen: ${errorMessage(error)}`)
    }
  },

  openAddAgent() {
    set({ addAgentOpen: true })
  },

  closeAddAgent() {
    set({ addAgentOpen: false })
  },

  async addAgent(selection) {
    const s = get()
    const profile = activeProfile(s)
    const role = ADD_ROLES[s.addSeq % ADD_ROLES.length]
    try {
      const agent = await window.orca.agents.spawn({
        provider: selection.provider,
        model: selection.model,
        modelPreset: selection.modelPreset,
        role: `Subagent · ${role}`,
        yolo: s.yoloMaster,
        workingDir: effectiveRepoPath(s) || undefined,
        profileId: profile?.id,
        workspaceSessionId: s.activeWorkspaceSessionId ?? undefined
      })
      set({ addSeq: s.addSeq + 1, addAgentOpen: false })
      get().showToast(
        `Neuer Subagent gestartet — ${selection.provider}/${agent.model || 'CLI-Standard'}`
      )
      return true
    } catch (error) {
      get().showToast(`Agent konnte nicht starten: ${errorMessage(error)}`)
      return false
    }
  },

  async killAgent(id) {
    await window.orca.agents.kill(id)
  },

  async popout(id) {
    const agent = get().agents.find((a) => a.id === id)
    await window.orca.agents.popout(id)
    if (agent) {
      get().showToast(
        `„${agent.model || 'CLI-Standard'} · ${agent.role.split('·').pop()?.trim()}" als eigenes Fenster geöffnet ⧉`
      )
    }
  },

  openHandoff(id) {
    const agent = get().agents.find((a) => a.id === id)
    if (agent) set({ handoffSource: agent })
  },

  closeHandoff() {
    set({ handoffSource: null })
  },

  async handoff(req) {
    const source = get().agents.find((a) => a.id === req.sourceId)
    try {
      const target = await window.orca.agents.handoff(req)
      set({ handoffSource: null })
      get().showToast(`↪ Übergabe: ${source?.name ?? 'Agent'} → ${target.name}`)
    } catch (error) {
      get().showToast(`Übergabe fehlgeschlagen: ${errorMessage(error)}`)
    }
  },

  openEditor(profile) {
    set({ editorProfile: profile })
  },

  openEditorCopy(profile) {
    set({
      editorProfile: {
        ...profile,
        id: `profile-${Date.now().toString(36)}`,
        name: `${profile.name} (Kopie)`,
        orchestrator: profile.orchestrator ? { ...profile.orchestrator } : undefined,
        githubRepo: profile.githubRepo ? { ...profile.githubRepo } : undefined,
        agents: profile.agents.map((slot) => ({
          ...slot,
          strengths: [...slot.strengths],
          weaknesses: [...slot.weaknesses]
        })),
        planner: { ...profile.planner },
        benchmark: { ...profile.benchmark },
        autoPr: {
          ...profile.autoPr,
          qualityGates: [...profile.autoPr.qualityGates],
          labels: [...profile.autoPr.labels],
          reviewers: [...profile.autoPr.reviewers]
        }
      }
    })
  },

  openEditorNew() {
    set({
      editorProfile: {
        id: `profile-${Date.now().toString(36)}`,
        name: 'Neues Profil',
        workingDir: activeProfile(get())?.workingDir ?? '',
        orchestrator: {
          provider: 'claude',
          model: '',
          modelPreset: 'balanced',
          autoOpenSubwindows: true
        },
        agents: [
          {
            // Empty model = codex's own configured default (see DEFAULT_PROFILE).
            role: 'worker',
            provider: 'codex',
            model: '',
            modelPreset: 'balanced',
            count: 1,
            orchestrated: true,
            yolo: false,
            strengths: [],
            weaknesses: []
          }
        ],
        yoloDefault: false,
        planner: { mode: 'review', routingMode: 'adaptive', maxParallel: 6, maxRetries: 1 },
        benchmark: { enabled: false },
        autoPr: {
          mode: 'off',
          strategy: 'aggregate',
          baseBranch: '',
          qualityGates: ['corepack pnpm typecheck', 'corepack pnpm test', 'corepack pnpm lint'],
          labels: [],
          reviewers: []
        }
      }
    })
  },

  closeEditor() {
    set({ editorProfile: null })
  },

  async saveEditor(profile) {
    try {
      const profiles = await window.orca.saveProfile(profile)
      set({ profiles, editorProfile: null })
      const selected = await get().selectProfile(profile.id)
      if (selected) get().showToast(`Profil „${profile.name}" gespeichert.`)
    } catch (error) {
      get().showToast(`Profil konnte nicht gespeichert werden: ${errorMessage(error)}`)
    }
  },

  async deleteProfile(id) {
    const profile = get().profiles.find((item) => item.id === id)
    if (!profile) return

    try {
      const profiles = await window.orca.deleteProfile(id)
      const activeProfileId = await window.orca.getActiveProfileId()
      set({ profiles, activeProfileId, editorProfile: null })
      await get().refreshGit().catch(() => undefined)
      const replacementCreated = !profiles.some((item) => item.id === id)
      get().showToast(
        replacementCreated
          ? `Profil „${profile.name}" gelöscht. Das Standardprofil wurde wiederhergestellt.`
          : `Profil „${profile.name}" gelöscht.`
      )
    } catch (error) {
      get().showToast(`Profil konnte nicht gelöscht werden: ${errorMessage(error)}`)
    }
  },

  openMcpEditor() {
    set({ mcpEditorOpen: true })
  },

  closeMcpEditor() {
    set({ mcpEditorOpen: false })
  },

  openSpeechSettings() {
    set({ speechSettingsOpen: true })
  },

  closeSpeechSettings() {
    set({ speechSettingsOpen: false })
  },

  bumpSpeechStatus() {
    set((state) => ({ speechStatusRevision: state.speechStatusRevision + 1 }))
  },

  async saveMcpServers(servers) {
    try {
      const saved = await window.orca.saveMcpServers(servers)
      set({ mcpServers: saved, mcpEditorOpen: false })
      get().showToast(`MCP-Server gespeichert (${saved.length}).`)
    } catch (error) {
      get().showToast(`MCP-Server konnten nicht gespeichert werden: ${errorMessage(error)}`)
    }
  }
}))
