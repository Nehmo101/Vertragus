import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { WorkspaceAgentSummary, WorkspaceSummary } from '../../../preload'
import { activeLocale } from '../i18n'
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
  /** E1 Promote: merge this agent's branch into the repo's own checkout. */
  onPromote(agentId: string): void
}

/**
 * One agent line. The row brings the window to the front; a finished agent
 * whose window is still open also has an ✕ so it can leave the screen without
 * dropping the last task from the list. The `?` badge is a button: it folds an
 * answer field out below the row, which sends over the SAME host path the
 * orchestrator's `send_to_agent{questionId}` uses (H1).
 */
function AgentRow({ agent, onFocus, onCloseWindow, onAnswer, onPromote }: AgentProps): React.JSX.Element {
  const { t, i18n } = useTranslation()
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
    // F: children of a lead indent under it — flat list, no tree widget.
    <li className={agent.parentId ? 'panel-agent-line is-child' : 'panel-agent-line'}>
      <button
        type="button"
        className={agentRowClass(agent)}
        style={{ '--role-color': agent.roleColor } as React.CSSProperties}
        title={t('panel.focusAgent', { agent: agent.name })}
        onClick={() => onFocus(agent.agentId)}
      >
        <span className={agentDotClass(agent)} />
        <LoreTip
          className="panel-agent-name"
          name={agent.name}
          blurb={agentTooltip(t, activeLocale(i18n.language), agent)}
        />
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
      {agent.state === 'stopped' && agent.roleId !== 'orchestrator' ? (
        <button
          type="button"
          className="panel-agent-promote"
          title={t('panel.promoteBranch', { agent: agent.name })}
          aria-label={t('panel.promoteBranch', { agent: agent.name })}
          onClick={() => onPromote(agent.agentId)}
        >
          ⇪
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
  /** D2: steer the run — wakes the orchestrator's await_events. */
  onUserMessage(workspaceId: string, text: string): void
  /** E1 Promote — the user's click, merged by the host into the main checkout. */
  onPromoteAgent(workspaceId: string, agentId: string): void
}

/**
 * D3: the orchestrator asked the HUMAN. Same field as the agent answers, other
 * backend: the answer goes to the reserved agent id `user`, which resolves the
 * parked `ask_user` waiter.
 */
function UserQuestion({
  workspaceId,
  question,
  questionId,
  onAnswer
}: {
  workspaceId: string
  question: string
  questionId: string
  onAnswer(workspaceId: string, agentId: string, questionId: string, text: string): void
}): React.JSX.Element {
  const { t } = useTranslation()
  const [answer, setAnswer] = useState('')
  const submit = (): void => {
    if (!answer.trim()) return
    onAnswer(workspaceId, 'user', questionId, answer.trim())
    setAnswer('')
  }
  return (
    <div className="panel-answer panel-user-question">
      <p className="panel-answer-question">{t('panel.userQuestion', { question })}</p>
      <textarea
        className="panel-answer-input"
        rows={2}
        placeholder={t('panel.answerPlaceholder')}
        value={answer}
        onChange={(event) => setAnswer(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault()
            submit()
          }
        }}
      />
      <button type="button" className="panel-answer-send" disabled={!answer.trim()} onClick={submit}>
        {t('panel.answerSend')}
      </button>
    </div>
  )
}

/** D2: the card's composer — one line to steer the whole run. */
function Composer({
  workspaceId,
  onSend
}: {
  workspaceId: string
  onSend(workspaceId: string, text: string): void
}): React.JSX.Element {
  const { t } = useTranslation()
  const [text, setText] = useState('')
  const submit = (): void => {
    if (!text.trim()) return
    onSend(workspaceId, text.trim())
    setText('')
  }
  return (
    <div className="panel-composer">
      <input
        className="panel-answer-input"
        type="text"
        placeholder={t('panel.composerPlaceholder')}
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault()
            submit()
          }
        }}
      />
      <button type="button" className="panel-answer-send" disabled={!text.trim()} onClick={submit}>
        {t('panel.composerSend')}
      </button>
    </div>
  )
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
  onAnswerQuestion,
  onUserMessage,
  onPromoteAgent
}: Props): React.JSX.Element {
  const { t, i18n } = useTranslation()
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
            blurb={workspaceTooltip(t, activeLocale(i18n.language), workspace)}
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
          {workspace.userQuestion ? (
            <UserQuestion
              workspaceId={workspace.workspaceId}
              question={workspace.userQuestion.question}
              questionId={workspace.userQuestion.questionId}
              onAnswer={onAnswerQuestion}
            />
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
                  onPromote={(agentId) => onPromoteAgent(workspace.workspaceId, agentId)}
                />
              ))
            )}
          </ul>
          {workspace.active ? (
            <Composer workspaceId={workspace.workspaceId} onSend={onUserMessage} />
          ) : null}
        </>
      ) : null}
    </article>
  )
}
