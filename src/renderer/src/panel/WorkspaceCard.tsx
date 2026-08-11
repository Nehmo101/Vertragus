import type { WorkspaceAgentSummary, WorkspaceSummary } from '../../../preload'
import { StopIcon } from './icons'
import { PANEL_STRINGS } from './strings'
import {
  agentCountLabel,
  agentDotClass,
  agentStatusLine,
  agentTooltip,
  workspaceCardClass,
  workspaceTooltip
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
  return (
    <li>
      <button
        type="button"
        className="panel-agent"
        style={{ '--role-color': agent.roleColor } as React.CSSProperties}
        title={PANEL_STRINGS.focusAgent(agent.name)}
        onClick={() => onFocus(agent.agentId)}
      >
        <span className={agentDotClass(agent)} />
        <span className="panel-agent-name" title={agentTooltip(agent)}>
          {agent.name}
        </span>
        <span className="panel-agent-status">{agentStatusLine(agent)}</span>
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
  return (
    <article className={workspaceCardClass(workspace)}>
      <header className="panel-card-head">
        <span className="panel-card-name" title={workspaceTooltip(workspace)}>
          {workspace.name}
        </span>
        <span className="panel-card-count">{agentCountLabel(workspace)}</span>
        <button
          type="button"
          className="panel-stop"
          title={PANEL_STRINGS.stopWorkspace(workspace.name)}
          aria-label={PANEL_STRINGS.stopWorkspace(workspace.name)}
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
