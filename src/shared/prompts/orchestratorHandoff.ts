/**
 * Seed text for a successor orchestrator: the living loop rules plus the
 * frozen handoff package. English on purpose — same compliance reason as the
 * rest of the orchestrator prompt.
 */
import type { OrchestratorHandoffPackage } from '../schema/handoff'
import { buildOrchestratorSystemPrompt, type OrchestratorPromptInput } from './orchestrator'

export function formatHandoffSeed(pkg: OrchestratorHandoffPackage): string {
  const goal =
    pkg.goal?.current || pkg.goal?.original
      ? `Current goal: ${pkg.goal.current ?? pkg.goal.original}`
      : 'Current goal: (not recorded — confirm with the user if unclear).'
  const open =
    pkg.openQuestions.length === 0
      ? 'No open agent questions.'
      : [
          'Open questions (answer these first with send_to_agent{questionId}):',
          ...pkg.openQuestions.map(
            (question) => `- ${question.agentId} [${question.questionId}]: ${question.question}`
          )
        ].join('\n')
  const next =
    pkg.nextActions.length === 0
      ? 'No next-actions were recorded — inspect list_agents and continue the goal.'
      : ['Next actions:', ...pkg.nextActions.map((action) => `- ${action}`)].join('\n')

  return [
    `You are the successor of ${pkg.predecessor.name} in workspace "${pkg.workspaceName}".`,
    'This is a continuation of the same run, not a new one. Do not restart the work from scratch.',
    'Do not call record_retro until the goal is actually reached.',
    '',
    goal,
    `Your first await_events MUST use cursor ${pkg.eventCursor} (package.eventCursor). Do not start at 0.`,
    'Trust host facts in this package and on agent_done / inspect_agent over prose when they disagree.',
    '',
    open,
    '',
    next,
    '',
    'Full handoff package (JSON):',
    JSON.stringify(pkg, null, 2)
  ].join('\n')
}

export function buildSuccessorOrchestratorSystemPrompt(
  input: OrchestratorPromptInput,
  pkg: OrchestratorHandoffPackage
): string {
  return `${buildOrchestratorSystemPrompt(input)}\n\n${formatHandoffSeed(pkg)}`
}
