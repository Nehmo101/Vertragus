import { useEffect, useState } from 'react'
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

function useHashRoute(): string {
  const [hash, setHash] = useState(() => window.location.hash)
  useEffect(() => {
    const onChange = (): void => setHash(window.location.hash)
    window.addEventListener('hashchange', onChange)
    return () => window.removeEventListener('hashchange', onChange)
  }, [])
  return hash
}

export default function App(): JSX.Element {
  const store = useAppStore()
  const hash = useHashRoute()

  useEffect(() => {
    const ready = store.init()
    void ready
    // Dev/CI affordance for headless screenshots of modal UI.
    ;(window as unknown as { __orca?: unknown }).__orca = {
      ready,
      openEditor: (p: Parameters<typeof store.openEditor>[0]) => store.openEditor(p),
      openAddAgent: () => store.openAddAgent()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const paneMatch = hash.match(/^#\/pane\/(.+)$/)
  if (paneMatch) {
    return (
      <div className="app-root pane-window-root" data-theme={store.theme}>
        <PaneWindow agentId={paneMatch[1]} />
      </div>
    )
  }

  return (
    <div className="app-root" data-theme={store.theme} data-density={store.uiDensity}>
      <TitleBar />

      {store.yoloMaster && (
        <div className="yolo-strip">
          <span className="head">⚠ YOLO-MODUS AKTIV</span>
          <span className="rest">
            Alle Bestätigungen deaktiviert — Agents committen, pushen &amp; führen Shell-Befehle
            ohne Rückfrage aus.
          </span>
        </div>
      )}

      <div className={`body-row layout-${store.workspaceLayout}`}>
        <Sidebar />
        {hash === '#/inbox' ? <InboxPanel /> : hash === '#/remote' ? <RemotePanel /> : <Workspace />}
        {hash !== '#/remote' && <OrchestratorPanel />}
      </div>

      {store.editorProfile && <ProfileEditor key={store.editorProfile.id} />}

      {store.mcpEditorOpen && <McpServerEditor />}

      {store.speechSettingsOpen && <SpeechSettingsModal />}

      {store.handoffSource && <HandoffModal key={store.handoffSource.id} />}

      {store.addAgentOpen && <AddAgentModal />}

      {store.toast && (
        <div className="toast" role="status" aria-live="polite">
          <span className="diamond">◆</span>
          {store.toast}
        </div>
      )}
    </div>
  )
}
