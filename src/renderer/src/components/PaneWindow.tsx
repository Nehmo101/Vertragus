import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { AgentInstanceInfo } from '@shared/agents'
import AgentPane from '@renderer/components/AgentPane'
import styles from './PaneWindow.module.css'

/** Pop-out window: renders a single agent pane, mirroring the main grid. */
export default function PaneWindow({ agentId }: { agentId: string }): JSX.Element {
  const { t } = useTranslation()
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
            <strong className={styles.emptyTitle}>{t('agentPane.window.gone')}</strong>
            <span className={styles.emptyHint}>{t('agentPane.window.goneHint', { id: agentId })}</span>
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
