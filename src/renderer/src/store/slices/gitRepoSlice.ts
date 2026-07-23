/** Repository switching, git status and GitHub authentication. */
import type { StateCreator } from 'zustand'
import { profileRepoRef, repoRefKey } from '@shared/repoSwitcher'
import i18n from '@renderer/i18n'
import { effectiveRepoPath, errorMessage } from '../useAppStore'
import type { AppState, GitRepoSlice } from './types'

// Request/action sequence guards: a stale async response must never overwrite
// the result of a newer request.
let githubAuthRequest = 0
let githubAuthAction = 0

export const createGitRepoSlice: StateCreator<AppState, [], [], GitRepoSlice> = (set, get) => ({
  activeRepo: null,
  recentRepos: [],
  gitInfo: null,
  githubAuth: null,
  githubAuthBusy: false,

  async refreshGithubAuth() {
    const request = ++githubAuthRequest
    try {
      const githubAuth = await window.vertragus.githubAuthStatus()
      if (request === githubAuthRequest) set({ githubAuth })
    } catch (error) {
      // Do not keep displaying an old authenticated session when its status
      // can no longer be verified.
      if (request === githubAuthRequest) {
        set({ githubAuth: null })
        get().showToast(i18n.t('toast.githubStatusUnavailable', { error: errorMessage(error) }))
      }
    }
  },

  async githubLogin() {
    if (get().githubAuthBusy) return
    const action = ++githubAuthAction
    const request = ++githubAuthRequest
    set({ githubAuthBusy: true })
    try {
      const githubAuth = await window.vertragus.githubAuthLogin()
      if (request === githubAuthRequest) set({ githubAuth })
      void get().refreshHealth()
      get().showToast(
        githubAuth.needsReauth
          ? i18n.t('toast.githubScopesMissing', { scopes: githubAuth.missingScopes.join(', ') })
          : githubAuth.authenticated
            ? githubAuth.account
              ? i18n.t('toast.githubConnectedAs', { account: githubAuth.account })
              : i18n.t('toast.githubConnected')
            : i18n.t('toast.githubLoginIncomplete')
      )
    } catch (error) {
      get().showToast(i18n.t('toast.githubLoginFailed', { error: errorMessage(error) }))
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
      const githubAuth = await window.vertragus.githubAuthLogout()
      if (request === githubAuthRequest) set({ githubAuth })
      void get().refreshHealth()
      get().showToast(i18n.t('toast.githubLoggedOut'))
    } catch (error) {
      get().showToast(i18n.t('toast.githubLogoutFailed', { error: errorMessage(error) }))
      if (action === githubAuthAction) set({ githubAuthBusy: false })
      await get().refreshGithubAuth()
    } finally {
      if (action === githubAuthAction) set({ githubAuthBusy: false })
    }
  },

  async githubTerminalLogin() {
    await get().loginProvider('github')
  },

  async refreshGit() {
    const dir = effectiveRepoPath(get())
    const gitInfo = dir ? await window.vertragus.gitInfo(dir) : { isRepo: false }
    // This runs on a 10s poll. Skip the store write when nothing changed so the
    // (widely, store-wide subscribed) app tree does not re-render every 10s while idle.
    const current = get().gitInfo
    if (current && JSON.stringify(current) === JSON.stringify(gitInfo)) return
    set({ gitInfo })
  },

  async switchGitBranch(branch) {
    const dir = effectiveRepoPath(get())
    if (!dir) return false

    try {
      const gitInfo = await window.vertragus.gitSwitchBranch(dir, branch)
      set({ gitInfo })
      get().showToast(i18n.t('toast.branchSwitched', { branch: gitInfo.branch ?? branch }))
      return true
    } catch (error) {
      get().showToast(i18n.t('toast.branchSwitchFailed', { error: errorMessage(error) }))
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
      await window.vertragus.setConfig('workspaceRepo.active', ref)
      if (recentsChanged) void window.vertragus.setConfig('workspaceRepo.recent', recentRepos)
    } catch (error) {
      set({ activeRepo: previous, recentRepos: previousRecents })
      get().showToast(i18n.t('toast.repoSwitchFailed', { error: errorMessage(error) }))
      return
    }

    await get().refreshGit().catch((error) => {
      get().showToast(i18n.t('toast.gitStatusUnavailable', { error: errorMessage(error) }))
    })
    const path = effectiveRepoPath(get())
    get().showToast(
      ref
        ? i18n.t('toast.repoSwitched', { repo: ref.label?.trim() || path || ref.path })
        : i18n.t('toast.repoFollowsProfile')
    )
  },

  async addRepoFromFolder() {
    const dir = await window.vertragus.pickFolder()
    if (!dir) return
    await get().selectRepo({ path: dir })
  }
})
