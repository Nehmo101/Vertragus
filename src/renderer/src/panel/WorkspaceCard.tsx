import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { WorkspaceAgentSummary, WorkspaceSummary } from '../../../preload'
import { LoreTip } from '../lore/LoreTip'
import { CloseIcon, StopIcon } from './icons'
import {
  agentCanCloseWindow,
  agentCountLabel,
  agentDotClass,
  agentRowClass,
  agentStatusLine,
  agentTooltip,
  workspaceCardClass,
  workspaceGoalLine,
  workspaceHasWaitingSubagent,
  workspaceTooltip
} from './viewModel'

interface AgentProps {
  agent: WorkspaceAgentSummary
  onFocus(agentId: string): void
  onCloseWindow(agentId: string): void
  /** Answer this agent's open question (H1) — absent while it has none. */
  onAnswer(agentId: string, questionId: string, text: string): void
}

/**
 * One agent line. The row brings the window to the front; a finished agent
 * whose window is still open also has an ✕ so it can leave the screen without
 * dropping the last task from the list. The `?` badge is a button: it folds an
 * answer field out below the row, which sends over the SAME host path the
 * orchestrator's `send_to_agent{questionId}` uses (H1).
 */
function AgentRow({ agent, onFocus, onCloseWindow, onAnswer }: AgentProps): React.JSX.Element {
  const { t } = useTranslation()
  const canClose = agentCanCloseWindow(agent)
  const [answering, setAnswering] = useState(false)
  const [answer, setAnswer] = useState('')
  const question = agent.pendingQuestion
  const questionId = agent.pendingQuestionId

  const submit = (): void => {
    if (!questionId || !answer.trim()) return
    onAnswer(agent.agentId, questionId, answer.trim())
    setAnswer('')
    setAnswering(false)
  }

  return (
    <li className="panel-agent-line">
      <button
        type="button"
        className={agentRowClass(agent)}
        style={{ '--role-color': agent.roleColor } as React.CSSProperties}
        title={t('panel.focusAgent', { agent: agent.name })}
        onClick={() => onFocus(agent.agentId)}
      >
        <span className={agentDotClass(agent)} />
        <LoreTip className="panel-agent-name" name={agent.name} blurb={agentTooltip(t, agent)} />
        <span className="panel-agent-status">{agentStatusLine(t, agent)}</span>
      </button>
      {question && questionId ? (
        <button
          type="button"
          className="panel-question"
          title={question}
          aria-label={t('panel.answerQuestion', { agent: agent.name })}
          aria-expanded={answering}
          onClick={() => setAnswering((current) => !current)}
        >
          ?
        </button>
      ) : null}
      {canClose ? (
        <button
          type="button"
          className="panel-agent-dismiss"
          title={t('panel.closeAgentWindow', { agent: agent.name })}
          aria-label={t('panel.closeAgentWindow', { agent: agent.name })}
          onClick={() => onCloseWindow(agent.agentId)}
        >
          <CloseIcon size={11} />
        </button>
      ) : null}
      {answering && question && questionId ? (
        <div className="panel-answer">
          <p className="panel-answer-question">{question}</p>
          <textarea
            className="panel-answer-input"
            rows={2}
            placeholder={t('panel.answerPlaceholder')}
            value={answer}
            autoFocus
            onChange={(event) => setAnswer(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault()
                submit()
              }
              if (event.key === 'Escape') setAnswering(false)
            }}
          />
          <button
            type="button"
            className="panel-answer-send"
            disabled={!answer.trim()}
            onClick={submit}
          >
            {t('panel.answerSend')}
          </button>
        </div>
      ) : null}
    </li>
  )
}

interface Props {
  workspace: WorkspaceSummary
  expanded: boolean
  onToggle(): void
  onStop(workspaceId: string): void
  onFocusAgent(agentId: string): void
  onCloseAgentWindow(agentId: string): void
  /** H1: answer one agent's open question over the shared host path. */
  onAnswerQuestion(workspaceId: string, agentId: string, questionId: string, text: string): void
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
  onFocusAgent,
  onCloseAgentWindow,
  onAnswerQuestion
}: Props): React.JSX.Element {
  const { t } = useTranslation()
  const stop = t('panel.stopWorkspace', { workspace: workspace.name })
  const toggle = expanded
    ? t('panel.collapseWorkspace', { workspace: workspace.name })
    : t('panel.expandWorkspace', { workspace: workspace.name })
  const goalLine = workspaceGoalLine(t, workspace)
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
        <>
          {workspace.orchestratorIdle ? (
            <p className="panel-card-goal is-idle" title={t('panel.orchestratorIdleTitle')}>
              {t('panel.orchestratorIdle')}
            </p>
          ) : null}
          {goalLine ? (
            <p
              className={workspace.goalText ? 'panel-card-goal' : 'panel-card-goal is-empty'}
              title={workspace.goalText || undefined}
            >
              {goalLine}
            </p>
          ) : null}
          <ul className="panel-agents">
            {workspace.agents.length === 0 ? (
              <li className="panel-agents-empty">{t('panel.noAgents')}</li>
            ) : (
              workspace.agents.map((agent) => (
                <AgentRow
                  key={agent.agentId}
                  agent={agent}
                  onFocus={onFocusAgent}
                  onCloseWindow={onCloseAgentWindow}
                  onAnswer={(agentId, questionId, text) =>
                    onAnswerQuestion(workspace.workspaceId, agentId, questionId, text)
                  }
                />
              ))
            )}
          </ul>
        </>
      ) : null}
    </article>
  )
}
