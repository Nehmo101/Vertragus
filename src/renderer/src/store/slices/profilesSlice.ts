/** Workspace profiles, workspace sessions and the profile editor modal. */
import type { StateCreator } from 'zustand'
import { duplicateProfile as createDuplicateProfile } from '@shared/profile'
import i18n from '@renderer/i18n'
import { activeProfile, errorMessage } from '../useAppStore'
import type { AppState, ProfilesSlice } from './types'

export const createProfilesSlice: StateCreator<AppState, [], [], ProfilesSlice> = (set, get) => ({
  profiles: [],
  activeProfileId: '',
  workspaceSessions: [],
  activeWorkspaceSessionId: null,
  editorProfile: null,

  async selectProfile(id) {
    if (id === get().activeProfileId) {
      await get().refreshGit().catch((error) => {
        get().showToast(i18n.t('toast.gitStatusUnavailable', { error: errorMessage(error) }))
      })
      return true
    }
    try {
      await window.vertragus.setActiveProfileId(id)
      const workspaceSessions = await window.vertragus.workspaceSessions.list()
      const activeSession = workspaceSessions.find(
        (session) => session.profileId === id && session.active
      )
      const snapshot = await window.vertragus.orchestrator.snapshot(id, activeSession?.id)
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
        get().showToast(i18n.t('toast.profileSwitchedGitUnavailable', { error: errorMessage(error) }))
      })
      return true
    } catch (error) {
      get().showToast(i18n.t('toast.profileSwitchFailed', { error: errorMessage(error) }))
      return false
    }
  },

  async selectWorkspaceSession(profileId, sessionId) {
    try {
      if (profileId !== get().activeProfileId) {
        await window.vertragus.setActiveProfileId(profileId)
      }
      const snapshot = await window.vertragus.workspaceSessions.setActive(profileId, sessionId)
      const workspaceSessions = await window.vertragus.workspaceSessions.list()
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
      get().showToast(i18n.t('toast.workspaceSelectFailed', { error: errorMessage(error) }))
      return false
    }
  },

  async removeWorkspaceSession(profileId, sessionId) {
    try {
      const workspaceSessions = await window.vertragus.workspaceSessions.remove(profileId, sessionId)
      const activeSession = workspaceSessions.find(
        (session) => session.profileId === profileId && session.active
      )
      const snapshot = await window.vertragus.orchestrator.snapshot(profileId, activeSession?.id)
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
      get().showToast(i18n.t('toast.workspaceRunRemoved'))
    } catch (error) {
      get().showToast(i18n.t('toast.workspaceRemoveFailed', { error: errorMessage(error) }))
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
        solo: false,
        yoloDefault: false,
        planner: { mode: 'review', routingMode: 'adaptive', maxParallel: 6, maxRetries: 1 },
        benchmark: { enabled: false },
        multiAgent: { enabled: false, stopLosers: true },
        autoGit: { enabled: false, targetBranch: '' },
        autoPr: {
          mode: 'off',
          strategy: 'aggregate',
          baseBranch: '',
          qualityGates: ['corepack pnpm typecheck', 'corepack pnpm test', 'corepack pnpm lint'],
          securityGateExcludes: [],
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
      const profiles = await window.vertragus.saveProfile(profile)
      set({ profiles, editorProfile: null })
      const selected = await get().selectProfile(profile.id)
      if (selected) get().showToast(i18n.t('toast.profileSaved', { name: profile.name }))
    } catch (error) {
      get().showToast(i18n.t('toast.profileSaveFailed', { error: errorMessage(error) }))
    }
  },

  async duplicateProfile(id) {
    try {
      const currentProfiles = get().profiles
      const source = currentProfiles.find((profile) => profile.id === id)
      if (!source) throw new Error(i18n.t('toast.sourceProfileNotFound'))

      const duplicate = createDuplicateProfile(source, currentProfiles)
      const profiles = await window.vertragus.saveProfile(duplicate)
      const savedDuplicate = profiles.find((profile) => profile.id === duplicate.id) ?? duplicate
      set({ profiles, editorProfile: savedDuplicate })
      get().showToast(i18n.t('toast.profileDuplicated', { source: source.name, duplicate: duplicate.name }))
    } catch (error) {
      get().showToast(i18n.t('toast.profileDuplicateFailed', { error: errorMessage(error) }))
    }
  },

  async deleteProfile(id) {
    const profile = get().profiles.find((item) => item.id === id)
    if (!profile) return
    const wasLastProfile = get().profiles.length === 1

    try {
      const profiles = await window.vertragus.deleteProfile(id)
      const activeProfileId = await window.vertragus.getActiveProfileId()
      set({ profiles, activeProfileId, editorProfile: null })
      await get().refreshGit().catch(() => undefined)
      get().showToast(
        wasLastProfile
          ? i18n.t('toast.profileDeletedLast', { name: profile.name })
          : i18n.t('toast.profileDeleted', { name: profile.name })
      )
    } catch (error) {
      get().showToast(i18n.t('toast.profileDeleteFailed', { error: errorMessage(error) }))
    }
  }
})
