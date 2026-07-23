/**
 * Central renderer state (zustand), wired to the real main-process API.
 *
 * The single store is composed from per-domain slice creators (see ./slices).
 * This file keeps: the one-time `init()` bootstrap (including the event
 * subscriptions and the canvas-default migration, which a source-text contract
 * test pins to this file), plus every pure helper/selector export so all
 * existing `@renderer/store/useAppStore` imports keep resolving unchanged.
 */
import { create } from 'zustand'
import type { AgentInstanceInfo, VertragusEvent } from '@shared/agents'
import { LIMIT_KIND_LABELS } from '@shared/agents'
import type { AgentProviderId, DisabledModels, ProviderEnabled } from '@shared/providers'
import {
  normalizeDisabledModels,
  normalizeProviderEnabled,
  normalizeProviderLimits
} from '@shared/providers'
import type { WorkspaceProfile } from '@shared/profile'
import {
  collectKnownRepos,
  parseActiveRepo,
  parseRecentRepos,
  profileRepoRef,
  resolveActiveRepoPath,
  type RepoRef
} from '@shared/repoSwitcher'
import type { ModelPreset } from '@shared/models'
import type { AppState } from './slices/types'
import { createProvidersSlice } from './slices/providersSlice'
import { createProfilesSlice } from './slices/profilesSlice'
import { createGitRepoSlice } from './slices/gitRepoSlice'
import { createAgentsSlice } from './slices/agentsSlice'
import { createOrchestratorSlice } from './slices/orchestratorSlice'
import { createUiSlice } from './slices/uiSlice'
import i18n from '@renderer/i18n'

export type {
  AppState,
  ProvidersSlice,
  ProfilesSlice,
  GitRepoSlice,
  AgentsSlice,
  OrchestratorSlice,
  UiSlice,
  InitSlice
} from './slices/types'

export interface ManualAgentSelection {
  provider: AgentProviderId
  model: string
  modelPreset?: ModelPreset
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export type UiTheme = 'light' | 'dark'
export type WorkspaceLayout = 'tiles' | 'focus' | 'canvas'
export type UiDensity = 'comfortable' | 'compact'

let initialized = false

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

/** Only agents belonging to the profile being deleted may block its deletion. */
export function profileHasRunningAgents(
  agents: AgentInstanceInfo[],
  profileId: string
): boolean {
  return agents.some(
    (agent) =>
      agent.profileId === profileId &&
      (agent.status === 'running' || agent.status === 'waiting')
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
): VertragusEvent[] {
  return state.events.filter(
    (event) =>
      (!event.profileId || event.profileId === state.activeProfileId) &&
      (!state.activeWorkspaceSessionId || event.workspaceSessionId === state.activeWorkspaceSessionId)
  )
}

/** Select only the task summary owned by the requested profile/session pair. */
export function workspaceTaskSummary(
  state: Pick<AppState, 'workspaceSessions'>,
  profileId: string,
  workspaceSessionId: string
): string | undefined {
  return state.workspaceSessions.find(
    (session) => session.profileId === profileId && session.id === workspaceSessionId
  )?.taskSummary
}

export type WorkspaceUserAttentionSource = 'orchestrator' | 'subagent'

export interface WorkspaceUserAttention {
  source: WorkspaceUserAttentionSource
  agentId?: string
  agentName?: string
}

/**
 * Return the strongest canonical signal that a workspace is waiting for the
 * user. Orchestrator review gates and waiting orchestrator panes take priority;
 * a waiting subagent is the fallback. Task text and generic lifecycle states
 * are intentionally ignored so running or failed work cannot spoof attention.
 */
export function workspaceUserAttention(
  state: Pick<AppState, 'agents' | 'orchestrators'> &
    Partial<Pick<AppState, 'workspaceSessions'>>,
  profileId: string,
  workspaceSessionId?: string
): WorkspaceUserAttention | null {
  const knownSessionIds = state.workspaceSessions
    ? new Set(
        state.workspaceSessions
          .filter((session) => session.profileId === profileId)
          .map((session) => session.id)
      )
    : undefined
  const snapshots = Object.entries(state.orchestrators)
    .filter(([key, snapshot]) => {
      if (snapshot.profileId && snapshot.profileId !== profileId) return false
      if (workspaceSessionId) {
        return key === workspaceSessionId || snapshot.workspaceSessionId === workspaceSessionId
      }
      const matchesProfile = snapshot.profileId === profileId || (!snapshot.profileId && key === profileId)
      return matchesProfile &&
        (!snapshot.workspaceSessionId || !knownSessionIds || knownSessionIds.has(snapshot.workspaceSessionId))
    })
    .map(([, snapshot]) => snapshot)

  if (
    snapshots.some(
      (snapshot) => snapshot.pendingPlan != null || snapshot.activity?.phase === 'awaiting-review'
    )
  ) {
    return { source: 'orchestrator' }
  }

  const waitingAgents = state.agents.filter((agent) => {
    if (agent.profileId !== profileId || agent.status !== 'waiting') return false
    if (workspaceSessionId) return agent.workspaceSessionId === workspaceSessionId
    return !agent.workspaceSessionId || !knownSessionIds || knownSessionIds.has(agent.workspaceSessionId)
  })
  const orchestrator = waitingAgents.find((agent) => agent.kind === 'orchestrator')
  if (orchestrator) {
    return {
      source: 'orchestrator',
      agentId: orchestrator.id,
      agentName: orchestrator.name
    }
  }

  const subagent = waitingAgents.find((agent) => agent.kind === 'sub')
  return subagent
    ? { source: 'subagent', agentId: subagent.id, agentName: subagent.name }
    : null
}

/**
 * One-time canvas-default migration (D1). Existing installs defaulted to the
 * `tiles` layout; the spatial canvas is now the intended entry surface. The
 * first time this runs (before `ui.canvasDefaultApplied` is persisted) the
 * layout is forced to `canvas` exactly once — afterwards the user's stored
 * choice is always respected. The legacy `dag` list layout still folds to canvas.
 */
export function resolveInitialLayout(
  rawLayout: unknown,
  canvasDefaultApplied: boolean | undefined
): { layout: WorkspaceLayout; applyCanvasDefault: boolean } {
  const stored: WorkspaceLayout =
    rawLayout === 'focus' || rawLayout === 'canvas'
      ? rawLayout
      : (rawLayout as string) === 'dag'
        ? 'canvas'
        : 'tiles'
  if (!canvasDefaultApplied) {
    return { layout: 'canvas', applyCanvasDefault: true }
  }
  return { layout: stored, applyCanvasDefault: false }
}

/**
 * A7: translate a broadcast config change (from any window persisting a value)
 * into the local store patch that mirrors shared UI settings. Returns null for
 * keys the renderer does not mirror. Pure, so the key/value normalization is
 * unit-tested without standing up a full `init()`. The receiver only mirrors —
 * it never writes back — so the broadcast cannot loop.
 */
export function remoteConfigPatch(
  key: string,
  value: unknown
): { theme: UiTheme } | { uiDensity: UiDensity } | { cliReadable: boolean } | null {
  if (key === 'ui.theme') return { theme: value === 'dark' ? 'dark' : 'light' }
  if (key === 'ui.density') return { uiDensity: value === 'compact' ? 'compact' : 'comfortable' }
  if (key === 'ui.cliReadable') return { cliReadable: value === true }
  return null
}

/** Map a voice-assistant `open_view` target to an app hash route ('' = main workspace). */
export function uiCommandViewToHash(view: string | undefined): string {
  switch ((view ?? '').trim().toLowerCase()) {
    case 'inbox':
    case 'ideas':
      return '#/inbox'
    case 'remote':
    case 'mission':
    case 'missioncontrol':
      return '#/remote'
    case 'approvals':
    case 'approval':
      return '#/approvals'
    case 'changes':
    case 'diff':
    case 'diffs':
      return '#/changes'
    case 'canvas':
    case 'workspace':
    case 'board':
    case 'home':
      return '#/'
    default:
      return '#/'
  }
}

export const useAppStore = create<AppState>()((set, get, api) => ({
  ...createProvidersSlice(set, get, api),
  ...createProfilesSlice(set, get, api),
  ...createGitRepoSlice(set, get, api),
  ...createAgentsSlice(set, get, api),
  ...createOrchestratorSlice(set, get, api),
  ...createUiSlice(set, get, api),

  async init() {
    if (initialized) return
    initialized = true

    window.vertragus.agents.onChanged((agents) => {
      // Surface a toast the first time an agent trips a usage-limit signal.
      const prev = get().agents
      for (const a of agents) {
        if (!a.limitWarning) continue
        const before = prev.find((p) => p.id === a.id)
        if (before?.limitWarning) continue
        const label = LIMIT_KIND_LABELS[a.limitWarning.kind]
        get().showToast(i18n.t('toast.limitNear', { name: a.name, kind: label }))
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
    window.vertragus.agents.onEvent((evt) =>
      set((s) => ({ events: [...s.events.slice(-199), evt] }))
    )
    window.vertragus.onProvidersChanged((health) => {
      set({ health })
      // The account-visible catalogue may change when the interactive login closes.
      void get().refreshModels()
      if (health.some((provider) => provider.id === 'github')) void get().refreshGithubAuth()
    })
    // A7: mirror shared UI settings the moment any window persists them, so a
    // theme/density/readable-panes change in the main window updates open agent
    // panes and the voice overlay live. Receivers only mirror (no setConfig),
    // so the broadcast can never loop back.
    window.vertragus.onConfigChanged(({ key, value }) => {
      const patch = remoteConfigPatch(key, value)
      if (patch) set(patch)
    })
    window.vertragus.workspaceSessions.onChanged((workspaceSessions) =>
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
    window.vertragus.orchestrator.onSnapshot((snap) =>
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
      recentReposRaw,
      canvasDefaultApplied
    ] =
      await Promise.all([
        window.vertragus.getAppInfo(),
        window.vertragus.listProfiles(),
        window.vertragus.getActiveProfileId(),
        window.vertragus.listMcpServers(),
        window.vertragus.agents.list(),
        window.vertragus.getConfig<boolean>('yoloMaster'),
        window.vertragus.getActiveProfileId().then((profileId) =>
          window.vertragus.orchestrator.snapshot(profileId)),
        window.vertragus.getConfig<UiTheme>('ui.theme'),
        window.vertragus.getConfig<WorkspaceLayout>('ui.workspaceLayout'),
        window.vertragus.getConfig<UiDensity>('ui.density'),
        window.vertragus.getConfig<Partial<Record<AgentProviderId, number>>>('providerLimits'),
        window.vertragus.workspaceSessions.list(),
        window.vertragus.getConfig<Partial<ProviderEnabled>>('providerEnabled'),
        window.vertragus.getConfig<Partial<DisabledModels>>('disabledModels'),
        window.vertragus.getConfig<boolean>('ui.cliReadable'),
        window.vertragus.getConfig<unknown>('workspaceRepo.active'),
        window.vertragus.getConfig<unknown>('workspaceRepo.recent'),
        window.vertragus.getConfig<boolean>('ui.canvasDefaultApplied')
      ])
    // One-time canvas-default migration (D1): force canvas on first run only.
    const { layout: initialLayout, applyCanvasDefault } = resolveInitialLayout(
      layout,
      canvasDefaultApplied
    )
    if (applyCanvasDefault) {
      void window.vertragus.setConfig('ui.workspaceLayout', 'canvas')
      void window.vertragus.setConfig('ui.canvasDefaultApplied', true)
    }
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
      workspaceLayout: initialLayout,
      uiDensity: density === 'compact' ? density : 'comfortable',
      cliReadable: cliReadable ?? false,
      providerLimits: normalizeProviderLimits(limits),
      providerEnabled: normalizeProviderEnabled(providerEnabled),
      disabledModels: normalizeDisabledModels(disabledModels)
    })

    // The desktop Approval/Diff centers cover every live workspace, not only
    // the selected one. Hydrate the same authoritative per-session snapshots
    // that subsequently arrive over ev:orchestrator.
    void window.vertragus.workspaceSessions.list().then(async (currentSessions) => {
      const allSnapshots = await Promise.all(currentSessions.map((session) =>
        window.vertragus.orchestrator.snapshot(session.profileId, session.id)
      ))
      set((state) => ({
        workspaceSessions: currentSessions,
        orchestrators: Object.fromEntries([
          ...Object.entries(state.orchestrators),
          ...allSnapshots.map((item) => [item.workspaceSessionId ?? item.profileId!, item] as const)
        ])
      }))
    }).catch((error) => get().showToast(i18n.t('toast.workspaceOverviewIncomplete', { error: errorMessage(error) })))

    void get().refreshGit()
    void get().refreshHealth()
    void get().refreshGithubAuth()
    void get().refreshModels()
  }
}))
