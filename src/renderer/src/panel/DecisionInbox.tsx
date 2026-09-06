import { useTranslation } from 'react-i18next'
import type { WorkspaceSummary } from '../../../preload'
import { UserQuestion } from './WorkspaceCard'

/** A second view over the same questions; answers still use the single host registry. */
export function DecisionInbox({ workspaces, onAnswer, onFocus }: {
  workspaces: readonly WorkspaceSummary[]
  onAnswer(workspaceId: string, agentId: string, questionId: string, text: string): Promise<void>
  onFocus(workspaceId: string): void
}): React.JSX.Element | null {
  const { t } = useTranslation()
  const questions = workspaces.flatMap((workspace) => [
    ...(workspace.userQuestion ? [{ ...workspace.userQuestion, agentId: 'user', name: workspace.name, workspaceId: workspace.workspaceId }] : []),
    ...workspace.agents.flatMap((agent) => agent.pendingQuestion && agent.pendingQuestionId ? [{
      question: agent.pendingQuestion, questionId: agent.pendingQuestionId,
      choices: agent.pendingQuestionChoices, agentId: agent.agentId,
      name: `${workspace.name} · ${agent.name}`, workspaceId: workspace.workspaceId
    }] : [])
  ])
  if (questions.length === 0) return null
  return <details className="panel-decision-inbox" open>
    <summary className="panel-label">{t('panel.decisions', { count: questions.length })}</summary>
    {questions.map((question) => <section key={`${question.workspaceId}.${question.questionId}`}>
      <button className="panel-new" type="button" onClick={() => onFocus(question.workspaceId)}>{question.name}</button>
      <UserQuestion {...question} onAnswer={onAnswer} />
    </section>)}
  </details>
}
