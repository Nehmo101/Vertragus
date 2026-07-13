/**
 * Central renderer state (zustand), wired to the real main-process API.
 */
import { create } from 'zustand'
import type { AgentInstanceInfo, HandoffRequest, OrcaEvent } from '@shared/agents'
import { LIMIT_KIND_LABELS } from '@shared/agents'
import type { AgentProviderId, ProviderHealth, ProviderId } from '@shared/providers'
import {
  DEFAULT_MODELS,
  DEFAULT_PROVIDER_LIMITS,
  normalizeProviderLimits
} from '@shared/providers'
import type { WorkspaceProfile } from '@shared/profile'
import type { McpServerConfig } from '@shared/mcp'
import type { OrchestratorSnapshot } from '@shared/orchestrator'
import type { AppInfo, GitInfo, GithubAuthStatus } from '@shared/ipc'
import { profileRepoLocalPath } from '@shared/profile'

const ADD_ROLES = ['Docs / Changelog', 'Refactor / Cleanup', 'Security-Review', 'Perf / Bench']

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export type UiTheme = 'light' | 'dark'
export type WorkspaceLayout = 'tiles' | 'focus' | 'dag'
export type UiDensity = 'comfortable' | 'compact'

interface AppState {
  appInfo: AppInfo | null
  health: ProviderHealth[]
  models: Record<AgentProviderId, string[]>
  /** Per-provider Orca process gates shown live in the Limits panel. */
  providerLimits: Record<AgentProviderId, number>
  profiles: WorkspaceProfile[]
  activeProfileId: string
  /** User-configured external MCP servers attached to the launched agents. */
  mcpServers: McpServerConfig[]
  /** True while the MCP-server manager modal is open. */
  mcpEditorOpen: boolean
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
  toast: string | null
  /** Profile being edited in the modal; null = closed. */
  editorProfile: WorkspaceProfile | null
  /** Source agent for the handoff modal; null = closed. */
  handoffSource: AgentInstanceInfo | null
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
  selectProfile(id: string): Promise<boolean>
  setProviderLimit(provider: AgentProviderId, value: number): void
  toggleYolo(): void
  toggleTheme(): void
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
  addAgent(): Promise<void>
  killAgent(id: string): Promise<void>
  popout(id: string): Promise<void>
  openHandoff(id: string): void
  closeHandoff(): void
  handoff(req: HandoffRequest): Promise<void>
  openEditor(profile: WorkspaceProfile): void
  openEditorNew(): void
  closeEditor(): void
  saveEditor(profile: WorkspaceProfile): Promise<void>
  deleteProfile(id: string): Promise<void>
  openMcpEditor(): void
  closeMcpEditor(): void
  saveMcpServers(servers: McpServerConfig[]): Promise<void>
}

let toastTimer: ReturnType<typeof setTimeout> | undefined
let initialized = false
let githubAuthRequest = 0
let githubAuthAction = 0

export function activeProfile(s: Pick<AppState, 'profiles' | 'activeProfileId'>):
  | WorkspaceProfile
  | undefined {
  return s.profiles.find((p) => p.id === s.activeProfileId)
}

export function workspaceAgents(
  state: Pick<AppState, 'agents' | 'activeProfileId'>
): AgentInstanceInfo[] {
  return state.agents.filter(
    (agent) => !agent.profileId || agent.profileId === state.activeProfileId
  )
}

export function isFinishedSubagent(agent: AgentInstanceInfo): boolean {
  return agent.kind === 'sub' && (agent.status === 'stopped' || agent.status === 'error')
}

export function workspaceAgentHistory(
  state: Pick<AppState, 'agents' | 'activeProfileId'>
): AgentInstanceInfo[] {
  return workspaceAgents(state)
    .filter((agent) => agent.profileId === state.activeProfileId && isFinishedSubagent(agent))
    .sort((a, b) => b.startedAt - a.startedAt)
}

export function visibleWorkspaceAgents(
  state: Pick<AppState, 'agents' | 'activeProfileId' | 'reopenedAgentIds'>
): AgentInstanceInfo[] {
  const reopened = new Set(state.reopenedAgentIds)
  return workspaceAgents(state).filter(
    (agent) => !isFinishedSubagent(agent) || reopened.has(agent.id)
  )
}

export function workspaceEvents(
  state: Pick<AppState, 'events' | 'activeProfileId'>
): OrcaEvent[] {
  return state.events.filter((event) => !event.profileId || event.profileId === state.activeProfileId)
}

export const useAppStore = create<AppState>((set, get) => ({
  appInfo: null,
  health: [],
  models: DEFAULT_MODELS,
  providerLimits: DEFAULT_PROVIDER_LIMITS,
  profiles: [],
  activeProfileId: '',
  mcpServers: [],
  mcpEditorOpen: false,
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
  toast: null,
  editorProfile: null,
  handoffSource: null,
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
        reopenedAgentIds: state.reopenedAgentIds.filter((id) => retainedIds.has(id))
      }))
    })
    window.orca.agents.onEvent((evt) =>
      set((s) => ({ events: [...s.events.slice(-199), evt] }))
    )
    window.orca.onProvidersChanged((health) => {
      set({ health })
      // A provider login can change the account-visible model catalogue.
      void get().refreshModels()
      if (health.some((provider) => provider.id === 'github')) void get().refreshGithubAuth()
    })
    window.orca.orchestrator.onSnapshot((snap) =>
      set((state) => {
        const profileId = snap.profileId
        if (!profileId) return { orchestrator: snap }
        const orchestrators = { ...state.orchestrators, [profileId]: snap }
        return profileId === state.activeProfileId
          ? { orchestrators, orchestrator: snap }
          : { orchestrators }
      })
    )

    const [appInfo, profiles, activeProfileId, mcpServers, agents, yolo, snapshot, theme, layout, density, limits] =
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
        window.orca.getConfig<Partial<Record<AgentProviderId, number>>>('providerLimits')
      ])
    set({
      appInfo,
      profiles,
      activeProfileId,
      mcpServers,
      agents,
      yoloMaster: yolo ?? false,
      orchestrator: snapshot,
      orchestrators: { [activeProfileId]: snapshot },
      theme: theme === 'dark' ? 'dark' : 'light',
      workspaceLayout: layout === 'focus' || layout === 'dag' ? layout : 'tiles',
      uiDensity: density === 'compact' ? density : 'comfortable',
      providerLimits: normalizeProviderLimits(limits)
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
        githubAuth.authenticated
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
    const health = await window.orca.checkProviders()
    set({ health })
    if (health.some((provider) => provider.id === 'github')) void get().refreshGithubAuth()
  },

  async refreshModels() {
    try {
      const models = await window.orca.listModels()
      set({ models })
    } catch {
      // Model suggestions are optional. Keep the last known list when a
      // provider is unavailable or a live probe times out.
    }
  },

  async loginProvider(id) {
    const provider = get().health.find((item) => item.id === id)
    if (!provider?.available || !provider.canLogin) return
    try {
      await window.orca.loginProvider(id)
      void get().refreshModels()
      get().showToast(`${provider.loginLabel ?? 'Provider-Login'} im sicheren Terminal geöffnet.`)
    } catch (error) {
      get().showToast(`Login konnte nicht gestartet werden: ${errorMessage(error)}`)
    }
  },

  async refreshGit() {
    const profile = activeProfile(get())
    const dir = profile ? profileRepoLocalPath(profile) : ''
    const gitInfo = dir ? await window.orca.gitInfo(dir) : { isRepo: false }
    set({ gitInfo })
  },

  async switchGitBranch(branch) {
    const profile = activeProfile(get())
    const dir = profile ? profileRepoLocalPath(profile) : ''
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

  async selectProfile(id) {
    if (id === get().activeProfileId) {
      await get().refreshGit().catch((error) => {
        get().showToast(`Git-Status nicht verfügbar: ${errorMessage(error)}`)
      })
      return true
    }
    try {
      await window.orca.setActiveProfileId(id)
      const snapshot = await window.orca.orchestrator.snapshot(id)
      set((state) => ({
        activeProfileId: id,
        orchestrator: snapshot,
        orchestrators: { ...state.orchestrators, [id]: snapshot }
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

  setProviderLimit(provider, value) {
    const providerLimits = normalizeProviderLimits({ ...get().providerLimits, [provider]: value })
    set({ providerLimits })
    void window.orca.setConfig('providerLimits', providerLimits)
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
      await window.orca.agents.spawnProfile(profile.id, s.yoloMaster)
    } catch (error) {
      get().showToast(`Workspace konnte nicht starten: ${errorMessage(error)}`)
    }
  },

  async stopAll() {
    await window.orca.agents.killAll()
    get().showToast('Alle Agents gestoppt.')
  },

  async cleanWorkspace() {
    await window.orca.agents.clean(get().activeProfileId)
    get().showToast('Workspace geleert — alle Agents entfernt.')
  },

  async addAgent() {
    const s = get()
    const profile = activeProfile(s)
    const role = ADD_ROLES[s.addSeq % ADD_ROLES.length]
    try {
      // Empty model = codex uses its own ~/.codex/config.toml default (safe:
      // an explicit unsupported name 400s). The rich model list is a picker only.
      await window.orca.agents.spawn({
        provider: 'codex',
        model: '',
        role: `Subagent · ${role}`,
        yolo: s.yoloMaster,
        workingDir: profile?.workingDir,
        profileId: profile?.id
      })
      set({ addSeq: s.addSeq + 1 })
      get().showToast('Neuer Subagent gestartet — Codex-Default')
    } catch (error) {
      get().showToast(`Agent konnte nicht starten: ${errorMessage(error)}`)
    }
  },

  async killAgent(id) {
    await window.orca.agents.kill(id)
  },

  async popout(id) {
    const agent = get().agents.find((a) => a.id === id)
    await window.orca.agents.popout(id)
    if (agent) {
      get().showToast(`„${agent.model} · ${agent.role.split('·').pop()?.trim()}" als eigenes Fenster geöffnet ⧉`)
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

  openEditorNew() {
    set({
      editorProfile: {
        id: `profile-${Date.now().toString(36)}`,
        name: 'Neues Profil',
        workingDir: activeProfile(get())?.workingDir ?? '',
        orchestrator: { provider: 'claude', model: 'fable', modelPreset: 'balanced', autoOpenSubwindows: true },
        agents: [
          {
            // Empty model = codex's own configured default (see DEFAULT_PROFILE).
            role: 'worker',
            provider: 'codex',
            model: '',
            modelPreset: 'balanced',
            count: 1,
            orchestrated: true,
            yolo: false
          }
        ],
        yoloDefault: false,
        planner: { mode: 'review', maxParallel: 6 },
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
