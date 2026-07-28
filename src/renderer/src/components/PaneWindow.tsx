import { useEffect, useState } from 'react'
import type { AgentInstanceInfo } from '@shared/agents'
import AgentPane from '@renderer/components/AgentPane'
import styles from './PaneWindow.module.css'

/** Pop-out window: renders a single agent pane, mirroring the main grid. */
export default function PaneWindow({ agentId }: { agentId: string }): JSX.Element {
  const [agent, setAgent] = useState<AgentInstanceInfo | null>(null)

  useEffect(() => {
    void window.vertragus.agents.list().then((list) => {
      setAgent(list.find((a) => a.id === agentId) ?? null)
    })
    return window.vertragus.agents.onChanged((list) => {
      setAgent(list.find((a) => a.id === agentId) ?? null)
    })
  }, [agentId])

  if (!agent) {
    return (
      <div className="pane-window">
        <div className={styles.emptyWrap}>
          <div className={styles.emptyCard} role="status">
            <span className={styles.emptyIcon} aria-hidden="true">◌</span>
            <strong className={styles.emptyTitle}>Agent läuft nicht mehr</strong>
            <span className={styles.emptyHint}>
              Der Agent „{agentId}“ wurde beendet oder aufgeräumt. Dieses Fenster kann
              geschlossen werden.
            </span>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="pane-window">
      <AgentPane agent={agent} />
    </div>
  )
}
