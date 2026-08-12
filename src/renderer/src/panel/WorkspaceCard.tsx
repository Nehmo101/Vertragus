import { useTranslation } from 'react-i18next'
import type { WorkspaceAgentSummary, WorkspaceSummary } from '../../../preload'
import { LoreTip } from '../lore/LoreTip'
import { StopIcon } from './icons'
import {
  agentCountLabel,
  agentDotClass,
  agentRowClass,
  agentStatusLine,
  agentTooltip,
  workspaceCardClass,
  workspaceHasWaitingSubagent,
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
  const { t } = useTranslation()
  return (
    <li>
      <button
        type="button"
        className={agentRowClass(agent)}
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
  expanded: boolean
  onToggle(): void
  onStop(workspaceId: string): void
  onFocusAgent(agentId: string): void
}

/**
 * One workspace card: Commedia name, agent count, stop. Only the expanded card
 * lists its agents — collapsed peers keep the head so the rail stays scannable.
 */
export function WorkspaceCard({
  workspace,
  expanded,
  onToggle,
  onStop,
  onFocusAgent
}: Props): React.JSX.Element {
  const { t } = useTranslation()
  const stop = t('panel.stopWorkspace', { workspace: workspace.name })
  const toggle = expanded
    ? t('panel.collapseWorkspace', { workspace: workspace.name })
    : t('panel.expandWorkspace', { workspace: workspace.name })
  return (
    <article className={workspaceCardClass(workspace)}>
      <header className="panel-card-head">
        {/* No native `title` on the toggle: it would pop the OS tooltip on
            top of the lore card anchored to the name. The aria-label keeps the
            expand/collapse action announced. */}
        <button
          type="button"
          className="panel-card-toggle"
          aria-label={toggle}
          aria-expanded={expanded}
          onClick={onToggle}
        >
          <LoreTip
            className="panel-card-name"
            name={workspace.name}
            blurb={workspaceTooltip(t, workspace)}
          />
          <span className="panel-card-count">{agentCountLabel(t, workspace)}</span>
          {!expanded && workspaceHasWaitingSubagent(workspace) ? (
            // The blink belongs to the subagent's row, which a shut card hides
            // — this dot is only the "open me" hint.
            <span className="panel-card-attention" title={t('panel.subagentWaiting')} />
          ) : null}
        </button>
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
      {expanded ? (
        <ul className="panel-agents">
          {workspace.agents.length === 0 ? (
            <li className="panel-agents-empty">{t('panel.noAgents')}</li>
          ) : (
            workspace.agents.map((agent) => (
              <AgentRow key={agent.agentId} agent={agent} onFocus={onFocusAgent} />
            ))
          )}
        </ul>
      ) : null}
    </article>
  )
}
