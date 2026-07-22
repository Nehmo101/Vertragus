/** Workspace profiles, workspace sessions and the profile editor modal. */
import type { StateCreator } from 'zustand'
import { duplicateProfile as createDuplicateProfile } from '@shared/profile'
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
        get().showToast(`Git-Status nicht verfügbar: ${errorMessage(error)}`)
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
      get().showToast(`Workspace konnte nicht ausgewaehlt werden: ${errorMessage(error)}`)
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
      get().showToast('Workspace-Lauf entfernt.')
    } catch (error) {
      get().showToast(`Workspace konnte nicht entfernt werden: ${errorMessage(error)}`)
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
      if (selected) get().showToast(`Profil „${profile.name}" gespeichert.`)
    } catch (error) {
      get().showToast(`Profil konnte nicht gespeichert werden: ${errorMessage(error)}`)
    }
  },

  async duplicateProfile(id) {
    try {
      const currentProfiles = get().profiles
      const source = currentProfiles.find((profile) => profile.id === id)
      if (!source) throw new Error('Quellprofil wurde nicht gefunden.')

      const duplicate = createDuplicateProfile(source, currentProfiles)
      const profiles = await window.vertragus.saveProfile(duplicate)
      const savedDuplicate = profiles.find((profile) => profile.id === duplicate.id) ?? duplicate
      set({ profiles, editorProfile: savedDuplicate })
      get().showToast(`Profil "${source.name}" als "${duplicate.name}" dupliziert.`)
    } catch (error) {
      get().showToast(`Profil konnte nicht dupliziert werden: ${errorMessage(error)}`)
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
          ? `Profil „${profile.name}" gelöscht. Das Standardprofil wurde wiederhergestellt.`
          : `Profil „${profile.name}" gelöscht.`
      )
    } catch (error) {
      get().showToast(`Profil konnte nicht gelöscht werden: ${errorMessage(error)}`)
    }
  }
})
