import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { WorkspaceAgentSummary, WorkspaceSummary } from '../../../preload'
import { activeLocale } from '../i18n'
import { LoreTip } from '../lore/LoreTip'
import { ChevronIcon, CloseIcon, FolderIcon, StopIcon } from './icons'
import {
  agentCanCloseWindow,
  agentCountLabel,
  agentDotClass,
  agentRowClass,
  agentStatusLine,
  agentTooltip,
  taskOverflowLabel,
  taskProgressLabel,
  taskRowClass,
  taskRows,
  workspaceCanReplaceOrchestrator,
  workspaceCardClass,
  workspaceGoalLine,
  workspaceHasWaitingSubagent,
  workspaceSuccessionLabel,
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
  /** C6/S3: replace a dead or silent orchestrator — the run keeps its team. */
  onSucceedOrchestrator(workspaceId: string): void
  onFocusAgent(agentId: string): void
  onCloseAgentWindow(agentId: string): void
  /** H2 refill: hand a run that was started bare its goal (see GoalRefill). */
  onAssignGoal(workspaceId: string, goal: string): void
  /** H1: answer one agent's open question over the shared host path. */
  onAnswerQuestion(workspaceId: string, agentId: string, questionId: string, text: string): void
  /** D2: steer the run — wakes the orchestrator's await_events. */
  onUserMessage(workspaceId: string, text: string): void
  /** E1 Promote — the user's click, merged by the host into the main checkout. */
  onPromoteAgent(workspaceId: string, agentId: string): void
  /** Reveal this run's artefact folder in the OS file manager (desktop only). */
  onOpenRunFolder(workspaceId: string): void
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

/**
 * S4: the run's plan, read-only. The panel never mutates the board — completing
 * a task stays the orchestrator's decision after verification (host doctrine),
 * so this box has no buttons at all. Collapsed by default: the agent list is
 * what the card is for, and a 30-row plan would push it off the rail.
 */
function TaskBoardSection({ workspace }: { workspace: WorkspaceSummary }): React.JSX.Element {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const rows = taskRows(t, workspace)
  const overflow = taskOverflowLabel(t, workspace)
  const toggle = t('panel.tasksToggle', { workspace: workspace.name })
  return (
    <div className="panel-tasks">
      <button
        type="button"
        className="panel-tasks-head"
        aria-label={toggle}
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <ChevronIcon expanded={open} />
        <span className="panel-tasks-label">{t('panel.tasksLabel')}</span>
        <span className="panel-tasks-progress">{taskProgressLabel(t, workspace)}</span>
      </button>
      {open ? (
        <ul className="panel-tasks-list">
          {rows.map((row) => (
            <li key={row.taskId} className={taskRowClass(row)} title={row.title}>
              <span className="panel-task-glyph" aria-label={row.statusLabel}>
                {row.glyph}
              </span>
              <span className="panel-task-subject">{row.subject}</span>
              {row.ownerName ? (
                <span className="panel-task-owner">{row.ownerName}</span>
              ) : null}
              {row.hint ? <span className="panel-task-hint">{row.hint}</span> : null}
            </li>
          ))}
          {/* The cap is a display decision, so it is shown, not hidden: a list
              that simply stops reads as the end of the plan. */}
          {overflow ? (
            <li className="panel-task-row is-more" title={overflow}>
              <span className="panel-task-subject">{overflow}</span>
            </li>
          ) : null}
        </ul>
      ) : null}
    </div>
  )
}

/**
 * H2 refill: a run started bare never got a first user turn — its orchestrator
 * sits at its own prompt waiting. So the "no goal" line is a FIELD, not a note:
 * the text typed here takes the same handshake the start-time goal takes, and
 * the line turns into the quoted goal as soon as the CLI accepted it.
 */
function GoalRefill({
  workspaceId,
  hint,
  onAssign
}: {
  workspaceId: string
  hint: string
  onAssign(workspaceId: string, goal: string): void
}): React.JSX.Element {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [goal, setGoal] = useState('')
  const submit = (): void => {
    if (!goal.trim()) return
    onAssign(workspaceId, goal.trim())
    setGoal('')
    setOpen(false)
  }
  return (
    <div className="panel-card-refill">
      <button
        type="button"
        className="panel-card-goal is-empty is-refill"
        aria-expanded={open}
        title={t('panel.assignGoalTitle')}
        onClick={() => setOpen((current) => !current)}
      >
        {hint}
      </button>
      {open ? (
        <div className="panel-goal-late">
          <textarea
            className="panel-goal-input"
            rows={2}
            placeholder={t('panel.goalPlaceholder')}
            value={goal}
            autoFocus
            onChange={(event) => setGoal(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault()
                submit()
              }
              if (event.key === 'Escape') setOpen(false)
            }}
          />
          <button
            type="button"
            className="panel-answer-send"
            disabled={!goal.trim()}
            onClick={submit}
          >
            {t('panel.assignGoalSend')}
          </button>
        </div>
      ) : null}
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
 * A3: the run's pull request. A successful one is a link — the panel window
 * routes an https target to the OS browser (see windows/navigation), so no new
 * IPC channel is needed for it. A failed one is the reason, because "auto-PR
 * was on and nothing happened" is the state a user must never have to guess
 * about; when the branch still reached the remote, the reason carries the
 * compare link and the same anchor opens that instead.
 */
function PullRequestLine({
  pullRequest
}: {
  pullRequest: NonNullable<WorkspaceSummary['pullRequest']>
}): React.JSX.Element {
  const { t } = useTranslation()
  const { ok, url, message } = pullRequest
  const label = ok ? t('panel.pullRequestOpen') : t('panel.pullRequestNone')
  return (
    <p className={ok ? 'panel-card-pr' : 'panel-card-pr is-failed'} title={message || url}>
      {url ? (
        <a href={url} target="_blank" rel="noreferrer">
          {label}
        </a>
      ) : (
        label
      )}
      {!ok && message ? <span className="panel-card-pr-reason">{message}</span> : null}
    </p>
  )
}

/**
 * One workspace card: Commedia name, current goal, agent count, stop. Only the
 * expanded card lists its agents — collapsed peers keep the head so the rail
 * stays scannable. The goal line is shown collapsed and expanded.
 */
export function WorkspaceCard({
  workspace,
  expanded,
  onToggle,
  onStop,
  onSucceedOrchestrator,
  onFocusAgent,
  onCloseAgentWindow,
  onAssignGoal,
  onAnswerQuestion,
  onUserMessage,
  onPromoteAgent,
  onOpenRunFolder
}: Props): React.JSX.Element {
  const { t, i18n } = useTranslation()
  const stop = t('panel.stopWorkspace', { workspace: workspace.name })
  const succession = workspaceSuccessionLabel(t, workspace)
  const replace = t('panel.replaceOrchestrator', { workspace: workspace.name })
  const runFolder = t('panel.openRunFolder')
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
          {succession ? (
            // In the head, not in the body: a collapsed card must not hide
            // that its orchestrator is being replaced right now.
            <span className="panel-card-badge" title={t('panel.successionTitle')}>
              {succession}
            </span>
          ) : null}
        </button>
        {/* Next to stop because it is the other thing you do to a whole run —
            and unlike stop it stays useful once the run is over. */}
        <button
          type="button"
          className="panel-icon-button panel-run-folder"
          title={runFolder}
          aria-label={runFolder}
          onClick={() => onOpenRunFolder(workspace.workspaceId)}
        >
          <FolderIcon size={11} />
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
      {goalLine ? (
        workspace.goalText ? (
          <p className="panel-card-goal" title={workspace.goalText}>
            {goalLine}
          </p>
        ) : (
          // No goal and the run is alive — the line is the way to fix that.
          // It sits outside the expanded block like the line it replaces: a
          // shut card must show the goal, and offer the field that fills it.
          <GoalRefill
            workspaceId={workspace.workspaceId}
            hint={goalLine}
            onAssign={onAssignGoal}
          />
        )
      ) : null}
      {expanded ? (
        <>
          {workspace.orchestratorIdle ? (
            <p className="panel-card-goal is-idle" title={t('panel.orchestratorIdleTitle')}>
              {t('panel.orchestratorIdle')}
            </p>
          ) : null}
          {workspaceCanReplaceOrchestrator(workspace) ? (
            // C5's escape hatch and the dead-orchestrator recovery are one
            // button: the team, the worktrees and the task board survive, only
            // the brain is replaced. Stop would end the run instead.
            <button
              type="button"
              className="panel-card-replace"
              title={t('panel.replaceOrchestratorTitle')}
              aria-label={replace}
              onClick={() => onSucceedOrchestrator(workspace.workspaceId)}
            >
              {t('panel.replaceOrchestratorAction')}
            </button>
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
          {workspace.tasks && workspace.tasks.length > 0 ? (
            <TaskBoardSection workspace={workspace} />
          ) : null}
          {workspace.pullRequest ? <PullRequestLine pullRequest={workspace.pullRequest} /> : null}
          {workspace.active ? (
            <Composer workspaceId={workspace.workspaceId} onSend={onUserMessage} />
          ) : null}
        </>
      ) : null}
    </article>
  )
}
