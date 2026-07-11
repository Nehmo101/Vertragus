import { useEffect, useState } from 'react'
import type { AgentInstanceInfo } from '@shared/agents'
import AgentPane from '@renderer/components/AgentPane'

/** Pop-out window: renders a single agent pane, mirroring the main grid. */
export default function PaneWindow({ agentId }: { agentId: string }): JSX.Element {
  const [agent, setAgent] = useState<AgentInstanceInfo | null>(null)

  useEffect(() => {
    void window.orca.agents.list().then((list) => {
      setAgent(list.find((a) => a.id === agentId) ?? null)
    })
    return window.orca.agents.onChanged((list) => {
      setAgent(list.find((a) => a.id === agentId) ?? null)
    })
  }, [agentId])

  if (!agent) {
    return (
      <div className="pane-window" style={{ alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ color: 'var(--text-3)', fontSize: 13 }}>
          Agent {agentId} läuft nicht mehr.
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
