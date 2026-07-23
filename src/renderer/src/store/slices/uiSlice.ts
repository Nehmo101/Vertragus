/** App-shell UI: theme/layout/density, readable panes, toast, MCP + speech modals. */
import type { StateCreator } from 'zustand'
import i18n from '@renderer/i18n'
import { effectivePaneReadable, errorMessage, uiCommandViewToHash } from '../useAppStore'
import type { AppState, UiSlice } from './types'

let toastTimer: ReturnType<typeof setTimeout> | undefined

export const createUiSlice: StateCreator<AppState, [], [], UiSlice> = (set, get) => ({
  appInfo: null,
  theme: 'light',
  workspaceLayout: 'tiles',
  uiDensity: 'comfortable',
  cliReadable: false,
  paneReadable: {},
  toast: null,
  mcpServers: [],
  mcpEditorOpen: false,
  speechSettingsOpen: false,
  speechStatusRevision: 0,

  toggleTheme() {
    const next = get().theme === 'light' ? 'dark' : 'light'
    set({ theme: next })
    void window.vertragus.setConfig('ui.theme', next)
  },

  toggleCliReadable() {
    const next = !get().cliReadable
    set({ cliReadable: next })
    void window.vertragus.setConfig('ui.cliReadable', next)
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
    void window.vertragus.setConfig('ui.workspaceLayout', layout)
  },

  setUiDensity(density) {
    set({ uiDensity: density })
    void window.vertragus.setConfig('ui.density', density)
  },

  showToast(msg) {
    set({ toast: msg })
    clearTimeout(toastTimer)
    toastTimer = setTimeout(() => set({ toast: null }), 2600)
  },

  async exportDiagnostics() {
    try {
      const path = await window.vertragus.diagnostics.exportLatest(get().activeProfileId)
      get().showToast(
        path ? i18n.t('toast.diagnosticsExported', { path }) : i18n.t('toast.diagnosticsNoRun')
      )
    } catch (error) {
      get().showToast(i18n.t('toast.diagnosticsExportFailed', { error: errorMessage(error) }))
    }
  },

  applyUiCommand(command) {
    if (!command || typeof command !== 'object') return
    switch (command.kind) {
      case 'switch_layout': {
        const layout = command.layout
        if (layout === 'canvas' || layout === 'tiles' || layout === 'focus') {
          get().setWorkspaceLayout(layout)
        }
        return
      }
      case 'open_view': {
        const hash = uiCommandViewToHash(command.view)
        // A canvas/workspace target also implies the spatial layout.
        if (command.view && ['canvas', 'workspace', 'board', 'home'].includes(command.view.trim().toLowerCase())) {
          get().setWorkspaceLayout('canvas')
        }
        if (window.location.hash !== hash) window.location.hash = hash
        return
      }
      case 'set_active_session': {
        if (command.profileId && command.sessionId) {
          void get().selectWorkspaceSession(command.profileId, command.sessionId)
        }
        return
      }
      default:
        return
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
      const saved = await window.vertragus.saveMcpServers(servers)
      set({ mcpServers: saved, mcpEditorOpen: false })
      get().showToast(i18n.t('toast.mcpSaved', { count: saved.length }))
    } catch (error) {
      get().showToast(i18n.t('toast.mcpSaveFailed', { error: errorMessage(error) }))
    }
  },

  openSpeechSettings() {
    set({ speechSettingsOpen: true })
  },

  closeSpeechSettings() {
    set({ speechSettingsOpen: false })
  },

  bumpSpeechStatus() {
    set((state) => ({ speechStatusRevision: state.speechStatusRevision + 1 }))
  }
})
