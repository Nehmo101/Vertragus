/**
 * Central renderer state (zustand), wired to the real main-process API.
 */
import { create } from 'zustand'
import type { AgentInstanceInfo, OrcaEvent } from '@shared/agents'
import type { AgentProviderId, ProviderHealth } from '@shared/providers'
import { DEFAULT_MODELS } from '@shared/providers'
import type { WorkspaceProfile } from '@shared/profile'
import type { OrchestratorSnapshot } from '@shared/orchestrator'
import type { AppInfo, GitInfo } from '@shared/ipc'

const ADD_ROLES = ['Docs / Changelog', 'Refactor / Cleanup', 'Security-Review', 'Perf / Bench']

interface AppState {
  appInfo: AppInfo | null
  health: ProviderHealth[]
  models: Record<AgentProviderId, string[]>
  profiles: WorkspaceProfile[]
  activeProfileId: string
  gitInfo: GitInfo | null
  agents: AgentInstanceInfo[]
  events: OrcaEvent[]
  orchestrator: OrchestratorSnapshot
  yoloMaster: boolean
  toast: string | null
  /** Profile being edited in the modal; null = closed. */
  editorProfile: WorkspaceProfile | null
  addSeq: number

  init(): Promise<void>
  refreshHealth(): Promise<void>
  refreshGit(): Promise<void>
  selectProfile(id: string): Promise<void>
  toggleYolo(): void
  showToast(msg: string): void
  startAll(): Promise<void>
  stopAll(): Promise<void>
  addAgent(): Promise<void>
  killAgent(id: string): Promise<void>
  popout(id: string): Promise<void>
  openEditor(profile: WorkspaceProfile): void
  openEditorNew(): void
  closeEditor(): void
  saveEditor(profile: WorkspaceProfile): Promise<void>
}

let toastTimer: ReturnType<typeof setTimeout> | undefined
let initialized = false

export function activeProfile(s: Pick<AppState, 'profiles' | 'activeProfileId'>):
  | WorkspaceProfile
  | undefined {
  return s.profiles.find((p) => p.id === s.activeProfileId)
}

export const useAppStore = create<AppState>((set, get) => ({
  appInfo: null,
  health: [],
  models: DEFAULT_MODELS,
  profiles: [],
  activeProfileId: '',
  gitInfo: null,
  agents: [],
  events: [],
  orchestrator: { goal: null, tasks: [] },
  yoloMaster: false,
  toast: null,
  editorProfile: null,
  addSeq: 0,

  async init() {
    if (initialized) return
    initialized = true

    window.orca.agents.onChanged((agents) => set({ agents }))
    window.orca.agents.onEvent((evt) =>
      set((s) => ({ events: [...s.events.slice(-199), evt] }))
    )
    window.orca.orchestrator.onSnapshot((snap) => set({ orchestrator: snap }))

    const [appInfo, profiles, activeProfileId, agents, yolo, snapshot] = await Promise.all([
      window.orca.getAppInfo(),
      window.orca.listProfiles(),
      window.orca.getActiveProfileId(),
      window.orca.agents.list(),
      window.orca.getConfig<boolean>('yoloMaster'),
      window.orca.orchestrator.snapshot()
    ])
    set({ appInfo, profiles, activeProfileId, agents, yoloMaster: yolo ?? false, orchestrator: snapshot })

    void get().refreshGit()
    void get().refreshHealth()
    void window.orca.listModels().then((models) => set({ models }))
  },

  async refreshHealth() {
    const health = await window.orca.checkProviders()
    set({ health })
  },

  async refreshGit() {
    const profile = activeProfile(get())
    const gitInfo = profile?.workingDir
      ? await window.orca.gitInfo(profile.workingDir)
      : { isRepo: false }
    set({ gitInfo })
  },

  async selectProfile(id) {
    await window.orca.setActiveProfileId(id)
    set({ activeProfileId: id })
    void get().refreshGit()
  },

  toggleYolo() {
    const next = !get().yoloMaster
    set({ yoloMaster: next })
    void window.orca.setConfig('yoloMaster', next)
  },

  showToast(msg) {
    set({ toast: msg })
    clearTimeout(toastTimer)
    toastTimer = setTimeout(() => set({ toast: null }), 2600)
  },

  async startAll() {
    const s = get()
    const profile = activeProfile(s)
    if (!profile) return
    s.showToast(`Workspace „${profile.name}" startet…`)
    await window.orca.agents.spawnProfile(profile.id, s.yoloMaster)
  },

  async stopAll() {
    await window.orca.agents.killAll()
    get().showToast('Alle Agents gestoppt.')
  },

  async addAgent() {
    const s = get()
    const profile = activeProfile(s)
    const role = ADD_ROLES[s.addSeq % ADD_ROLES.length]
    set({ addSeq: s.addSeq + 1 })
    await window.orca.agents.spawn({
      provider: 'codex',
      model: s.models.codex[0] ?? 'gpt-5.6',
      role: `Subagent · ${role}`,
      yolo: s.yoloMaster,
      workingDir: profile?.workingDir
    })
    s.showToast(`Neuer Subagent gestartet — ${s.models.codex[0] ?? 'gpt-5.6'}`)
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

  openEditor(profile) {
    set({ editorProfile: profile })
  },

  openEditorNew() {
    const models = get().models
    set({
      editorProfile: {
        id: `profile-${Date.now().toString(36)}`,
        name: 'Neues Profil',
        workingDir: activeProfile(get())?.workingDir ?? '',
        orchestrator: { provider: 'claude', model: 'fable', autoOpenSubwindows: true },
        agents: [
          {
            role: 'worker',
            provider: 'codex',
            model: models.codex[0] ?? 'gpt-5.6',
            count: 1,
            orchestrated: true,
            yolo: false
          }
        ],
        yoloDefault: false
      }
    })
  },

  closeEditor() {
    set({ editorProfile: null })
  },

  async saveEditor(profile) {
    const profiles = await window.orca.saveProfile(profile)
    set({ profiles, editorProfile: null })
    await get().selectProfile(profile.id)
    get().showToast(`Profil „${profile.name}" gespeichert.`)
  }
}))
