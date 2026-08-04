import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '@renderer/store/useAppStore'
import TitleBar from '@renderer/components/TitleBar'
import Sidebar from '@renderer/components/Sidebar'
import Workspace from '@renderer/components/Workspace'
import OrchestratorPanel from '@renderer/components/OrchestratorPanel'
import ProfileEditor from '@renderer/components/ProfileEditor'
import McpServerEditor from '@renderer/components/McpServerEditor'
import HandoffModal from '@renderer/components/HandoffModal'
import PaneWindow from '@renderer/components/PaneWindow'
import InboxPanel from '@renderer/components/InboxPanel'
import AddAgentModal from '@renderer/components/AddAgentModal'
import SpeechSettingsModal from '@renderer/components/SpeechSettingsModal'
import RemotePanel from '@renderer/components/RemotePanel'
import SessionRestoreBanner from '@renderer/components/SessionRestoreBanner'
import MissionApprovalInbox from '@renderer/components/MissionApprovalInbox'
import DiffMergeCenter from '@renderer/components/DiffMergeCenter'
import { SpeechShortcutProvider } from '@renderer/features/speechShortcut/SpeechShortcutProvider'
import { AppShortcutProvider } from '@renderer/shortcuts/AppShortcutProvider'
import CommandPalette from '@renderer/components/palette/CommandPalette'
import VoiceOverlay from '@renderer/components/VoiceOverlay'
import { useAttentionSignal } from '@renderer/hooks/useAttentionSignal'
import { useHashRoute } from '@renderer/hooks/useHashRoute'
import { useDocumentLanguage } from '@renderer/hooks/useDocumentLanguage'

export default function App(): JSX.Element {
  const { t } = useTranslation()
  useAttentionSignal()
  useDocumentLanguage()
  // The root only reads low-frequency UI state (theme, layout, open modals,
  // toast). Selecting exactly those with a shallow comparison keeps App — and
  // therefore the whole tree it renders — from reconciling on every high-frequency
  // agent/orchestrator/git tick, which a bare useAppStore() would trigger.
  const store = useAppStore(
    useShallow((s) => ({
      theme: s.theme,
      uiDensity: s.uiDensity,
      yoloMaster: s.yoloMaster,
      workspaceLayout: s.workspaceLayout,
      editorProfile: s.editorProfile,
      mcpEditorOpen: s.mcpEditorOpen,
      speechSettingsOpen: s.speechSettingsOpen,
      handoffSource: s.handoffSource,
      addAgentOpen: s.addAgentOpen,
      toast: s.toast,
      init: s.init,
      openEditor: s.openEditor,
      openAddAgent: s.openAddAgent,
      applyUiCommand: s.applyUiCommand,
      toggleYolo: s.toggleYolo
    }))
  )
  const hash = useHashRoute()

  useEffect(() => {
    const ready = store.init()
    void ready
    // Dev/CI affordance for headless screenshots of modal UI.
    ;(window as unknown as { __vertragus?: unknown }).__vertragus = {
      ready,
      openEditor: (p: Parameters<typeof store.openEditor>[0]) => store.openEditor(p),
      openAddAgent: () => store.openAddAgent()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Voice-assistant UI navigation commands are broadcast to every window; only
  // the main application window (not the overlay or pop-outs) should apply them.
  useEffect(() => {
    const unsubscribe = window.vertragus.events.onUiCommand((command) => {
      const route = window.location.hash
      if (route.startsWith('#/voice') || route.startsWith('#/pane')) return
      store.applyUiCommand(command)
    })
    return unsubscribe
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (hash === '#/voice') {
    return (
      <div className="app-root voice-window-root" data-theme={store.theme}>
        <VoiceOverlay />
      </div>
    )
  }

  const paneMatch = hash.match(/^#\/pane\/(.+)$/)
  if (paneMatch) {
    return (
      <div className="app-root pane-window-root" data-theme={store.theme}>
        <PaneWindow agentId={paneMatch[1]} />
      </div>
    )
  }

  const content =
    hash === '#/inbox' ? (
      <InboxPanel />
    ) : hash === '#/remote' ? (
      <RemotePanel />
    ) : hash === '#/approvals' ? (
      <MissionApprovalInbox />
    ) : hash === '#/changes' ? (
      <DiffMergeCenter />
    ) : (
      <Workspace />
    )
  const showOrchestrator = !['#/inbox', '#/remote', '#/approvals', '#/changes'].includes(hash)

  return (
    <SpeechShortcutProvider>
    <AppShortcutProvider>
    <div className="app-root" data-theme={store.theme} data-density={store.uiDensity}>
      <TitleBar />

      <SessionRestoreBanner />

      {store.yoloMaster ? (
        <button
          type="button"
          className="yolo-strip"
          onClick={store.toggleYolo}
          title={t('app.yoloBanner.disable')}
        >
          <span className="head">{t('app.yoloBanner.head')}</span>
          <span className="rest">{t('app.yoloBanner.body')}</span>
          <span className="action">{t('app.yoloBanner.disable')}</span>
        </button>
      ) : (
        <button
          type="button"
          className="safe-strip"
          onClick={store.toggleYolo}
          title={t('app.safeMode.enable')}
        >
          <span className="head">{t('app.safeMode.head')}</span>
          <span className="rest">{t('app.safeMode.body')}</span>
          <span className="action">{t('app.safeMode.enable')}</span>
        </button>
      )}

      <div className={`body-row layout-${store.workspaceLayout}`}>
        <Sidebar />
        <div className="app-content">{content}</div>
        {showOrchestrator && <OrchestratorPanel />}
      </div>

      {store.editorProfile && <ProfileEditor key={store.editorProfile.id} />}

      {store.mcpEditorOpen && <McpServerEditor />}

      {store.speechSettingsOpen && <SpeechSettingsModal />}

      {store.handoffSource && <HandoffModal key={store.handoffSource.id} />}

      {store.addAgentOpen && <AddAgentModal />}

      {/* Kommandopalette (Mod+K): nur im Hauptfenster gemountet — die
          #/voice- und #/pane-Zweige returnen oben; den Listener samt Guards
          bringt die Komponente selbst mit. */}
      <CommandPalette />

      {store.toast && (
        <div className="toast" role="status" aria-live="polite">
          <span className="diamond">◆</span>
          {store.toast}
        </div>
      )}
    </div>
    </AppShortcutProvider>
    </SpeechShortcutProvider>
  )
}
