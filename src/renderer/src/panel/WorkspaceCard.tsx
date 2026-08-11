import { useTranslation } from 'react-i18next'
import type { WorkspaceAgentSummary, WorkspaceSummary } from '../../../preload'
import { LoreTip } from '../lore/LoreTip'
import { StopIcon } from './icons'
import {
  agentCountLabel,
  agentDotClass,
  agentStatusLine,
  agentTooltip,
  workspaceCardClass,
  workspacePlaceTooltip
} from './viewModel'

interface AgentProps {
  agent: WorkspaceAgentSummary
  onFocus(agentId: string): void
}

/**
 * One agent line. The whole row is the click target — "bring that window to the
 * front" is the only thing a user ever wants from it, so it should not require
 * hitting a 12px name.
 */
function AgentRow({ agent, onFocus }: AgentProps): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <li>
      <button
        type="button"
        className="panel-agent"
        style={{ '--role-color': agent.roleColor } as React.CSSProperties}
        title={t('panel.focusAgent', { agent: agent.name })}
        onClick={() => onFocus(agent.agentId)}
      >
        <span className={agentDotClass(agent)} />
        <LoreTip className="panel-agent-name" name={agent.name} blurb={agentTooltip(agent)} />
        <span className="panel-agent-status">{agentStatusLine(t, agent)}</span>
        {agent.pendingQuestion ? (
          <span className="panel-question" title={agent.pendingQuestion}>
            ?
          </span>
        ) : null}
      </button>
    </li>
  )
}

interface Props {
  workspace: WorkspaceSummary
  onStop(workspaceId: string): void
  onFocusAgent(agentId: string): void
}

/** One workspace card: Commedia name, agent count, stop — then its agents. */
export function WorkspaceCard({ workspace, onStop, onFocusAgent }: Props): React.JSX.Element {
  const { t } = useTranslation()
  const stop = t('panel.stopWorkspace', { workspace: workspace.name })
  return (
    <article className={workspaceCardClass(workspace)}>
      <header className="panel-card-head">
        <LoreTip
          className="panel-card-name"
          name={workspace.name}
          blurb={workspacePlaceTooltip(workspace)}
        />
        <span className="panel-card-count">{agentCountLabel(t, workspace)}</span>
        <button
          type="button"
          className="panel-stop"
          title={stop}
          aria-label={stop}
          onClick={() => onStop(workspace.workspaceId)}
        >
          <StopIcon />
        </button>
      </header>
      <ul className="panel-agents">
        {workspace.agents.map((agent) => (
          <AgentRow key={agent.agentId} agent={agent} onFocus={onFocusAgent} />
        ))}
      </ul>
    </article>
  )
}
