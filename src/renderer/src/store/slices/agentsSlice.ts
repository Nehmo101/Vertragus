/** Agent lifecycle: spawn/kill/handoff, pane selection and history reopen. */
import type { StateCreator } from 'zustand'
import { workspacePlaceName } from '@shared/workspaceNames'
import i18n from '@renderer/i18n'
import { activeProfile, effectiveRepoPath, errorMessage } from '../useAppStore'
import type { AgentsSlice, AppState } from './types'

const ADD_ROLES = ['Docs / Changelog', 'Refactor / Cleanup', 'Security-Review', 'Perf / Bench']

export const createAgentsSlice: StateCreator<AppState, [], [], AgentsSlice> = (set, get) => ({
  agents: [],
  events: [],
  selectedAgentId: null,
  reopenedAgentIds: [],
  handoffSource: null,
  handoffBulk: false,
  addAgentOpen: false,
  addSeq: 0,

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
      s.showToast(i18n.t('toast.noProfileSelected'))
      return
    }
    s.showToast(i18n.t('toast.workspaceStarting', { name: profile.name }))
    try {
      const spawned = await window.vertragus.agents.spawnProfile(profile.id, s.yoloMaster)
      const workspaceSessionId = spawned.find((agent) => agent.workspaceSessionId)?.workspaceSessionId
      if (workspaceSessionId) {
        // Falls through below to hydrate state; the id is returned to callers
        // (canvas composer) so they can target the freshly started session.
        const [workspaceSessions, snapshot] = await Promise.all([
          window.vertragus.workspaceSessions.list(),
          window.vertragus.orchestrator.snapshot(profile.id, workspaceSessionId)
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
          const name = startedSession.name || workspacePlaceName(startedSession.sequence)
          get().showToast(i18n.t('toast.workspaceSessionStarted', { sequence: startedSession.sequence, name }))
        } else {
          get().showToast(i18n.t('toast.workspaceStarted'))
        }
        return workspaceSessionId
      }
    } catch (error) {
      get().showToast(i18n.t('toast.workspaceStartFailed', { error: errorMessage(error) }))
    }
    return undefined
  },

  async stopAll() {
    await window.vertragus.agents.killAll()
    get().showToast(i18n.t('toast.allAgentsStopped'))
  },

  async cleanWorkspace() {
    await window.vertragus.agents.clean(
      get().activeProfileId,
      get().activeWorkspaceSessionId ?? undefined
    )
    const workspaceSessions = await window.vertragus.workspaceSessions.list()
    const activeSession = workspaceSessions.find(
      (session) => session.profileId === get().activeProfileId && session.active
    )
    const snapshot = await window.vertragus.orchestrator.snapshot(
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
    get().showToast(i18n.t('toast.workspaceCleared'))
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
      const agent = await window.vertragus.agents.spawn({
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
        i18n.t('toast.subagentStarted', {
          provider: selection.provider,
          model: agent.model || i18n.t('toast.cliDefault')
        })
      )
      return true
    } catch (error) {
      get().showToast(i18n.t('toast.agentStartFailed', { error: errorMessage(error) }))
      return false
    }
  },

  async killAgent(id) {
    await window.vertragus.agents.kill(id)
  },

  async popout(id) {
    const agent = get().agents.find((a) => a.id === id)
    await window.vertragus.agents.popout(id)
    if (agent) {
      get().showToast(
        i18n.t('toast.agentPoppedOut', {
          model: agent.model || i18n.t('toast.cliDefault'),
          role: agent.role.split('·').pop()?.trim() ?? ''
        })
      )
    }
  },

  openHandoff(id, opts) {
    const agent = get().agents.find((a) => a.id === id)
    if (agent) set({ handoffSource: agent, handoffBulk: opts?.bulk ?? false })
  },

  closeHandoff() {
    set({ handoffSource: null, handoffBulk: false })
  },

  async handoff(req) {
    const source = get().agents.find((a) => a.id === req.sourceId)
    try {
      const target = await window.vertragus.agents.handoff(req)
      set({ handoffSource: null })
      get().showToast(
        source?.kind === 'orchestrator'
          ? i18n.t('toast.handoffOrchestrator', { source: source.name, target: target.name })
          : i18n.t('toast.handoff', {
              source: source?.name ?? i18n.t('toast.handoffAgentFallback'),
              target: target.name
            })
      )
    } catch (error) {
      get().showToast(i18n.t('toast.handoffFailed', { error: errorMessage(error) }))
    }
  },

  async bulkHandoff(req) {
    try {
      const result = await window.vertragus.agents.bulkHandoff(req)
      set({ handoffSource: null })
      const suffix =
        result.failures.length > 0 ? i18n.t('toast.bulkHandoffFailures', { count: result.failures.length }) : ''
      get().showToast(
        i18n.t('toast.bulkHandoff', {
          transferred: result.transferred.length,
          requested: result.requested
        }) + suffix
      )
    } catch (error) {
      get().showToast(i18n.t('toast.bulkHandoffFailed', { error: errorMessage(error) }))
    }
  }
})
