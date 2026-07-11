import { useEffect, useState } from 'react'
import { useAppStore } from '@renderer/store/useAppStore'
import TitleBar from '@renderer/components/TitleBar'
import Sidebar from '@renderer/components/Sidebar'
import Workspace from '@renderer/components/Workspace'
import OrchestratorPanel from '@renderer/components/OrchestratorPanel'
import ProfileEditor from '@renderer/components/ProfileEditor'
import PaneWindow from '@renderer/components/PaneWindow'

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
    void store.init()
    // Dev/CI affordance for headless screenshots of modal UI.
    ;(window as unknown as { __orca?: unknown }).__orca = {
      openEditor: (p: Parameters<typeof store.openEditor>[0]) => store.openEditor(p)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const paneMatch = hash.match(/^#\/pane\/(.+)$/)
  if (paneMatch) {
    return <PaneWindow agentId={paneMatch[1]} />
  }

  return (
    <div className="app-root">
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

      <div className="body-row">
        <Sidebar />
        <Workspace />
        <OrchestratorPanel />
      </div>

      {store.editorProfile && <ProfileEditor key={store.editorProfile.id} />}

      {store.toast && (
        <div className="toast">
          <span className="diamond">◆</span>
          {store.toast}
        </div>
      )}
    </div>
  )
}
