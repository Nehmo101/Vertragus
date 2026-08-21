/**
 * Seed text for a successor orchestrator: the living loop rules plus the
 * frozen handoff package. English on purpose — same compliance reason as the
 * rest of the orchestrator prompt.
 *
 * The package is rendered ONCE, as prose. It used to be prose plus the whole
 * package pretty-printed as JSON, which paid for every fact twice in the most
 * expensive prompt of the system. Every field a successor can act on has a
 * section below; pure bookkeeping (schemaVersion, ids, timestamps, limits) is
 * dropped on purpose, and per-agent notes (`agentNotes`) already arrive merged
 * into the roster as `agent.orchNote`.
 */
import type { HandoffRecentEvent, OrchestratorHandoffPackage } from '../schema/handoff'
import { buildOrchestratorSystemPrompt, type OrchestratorPromptInput } from './orchestrator'

/** Keep the tail only: older events are already condensed into the roster. */
const SEED_RECENT_EVENTS_MAX = 10

function renderRecentEvent(event: HandoffRecentEvent): string {
  const who = event.name ?? event.agentId
  const what = event.summary ?? event.question ?? event.message ?? event.status
  return `- #${event.seq} ${event.type}${who ? ` ${who}` : ''}${what ? `: ${what}` : ''}`
}

function section(title: string, lines: readonly string[]): string[] {
  return lines.length === 0 ? [] : ['', title, ...lines]
}

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
  const team =
    pkg.agents.length === 0
      ? 'No subagents are running for you right now — list_agents will confirm.'
      : [
          'Your team right now (host roster at handoff — these agents keep working for YOU):',
          ...pkg.agents.map((agent) => {
            const parts = [`- ${agent.name} [${agent.agentId}] (${agent.role}, ${agent.status})`]
            if (agent.branch) parts.push(`branch ${agent.branch}`)
            if (agent.pendingQuestionId) {
              parts.push(`waiting on your answer to question ${agent.pendingQuestionId}`)
            }
            if (agent.orchNote) parts.push(`note: ${agent.orchNote}`)
            if (agent.lastSummary) parts.push(`last reported: ${agent.lastSummary}`)
            if (agent.lastResult) parts.push(`last result: ${agent.lastResult}`)
            return parts.join(' — ')
          })
        ].join('\n')

  // S4: one sentence, because the board itself is host state — task_list is
  // the truth; the rows below only show that a plan exists to continue.
  const tasks =
    pkg.tasks.length === 0
      ? []
      : [
          '',
          'The task board is HOST state and survived this handoff — task_list shows it; do not rebuild it from prose:',
          ...pkg.tasks.map(
            (task) =>
              `- ${task.taskId} rev ${task.revision} (${task.status}${
                task.ownerAgentId ? `, owner ${task.ownerAgentId}` : ''
              }${task.blockedBy.length > 0 ? `, blockedBy ${task.blockedBy.join(',')}` : ''}): ${task.subject}`
          )
        ]

  return [
    `You are the successor of ${pkg.predecessor.name} in workspace "${pkg.workspaceName}".`,
    'This is a continuation of the same run, not a new one. Do not restart the work from scratch.',
    'Do not call record_retro until the goal is actually reached.',
    '',
    goal,
    `Your first await_events MUST use cursor ${pkg.eventCursor} (package.eventCursor). Do not start at 0.`,
    'Trust host facts in this package and on agent_done / inspect_agent over prose when they disagree.',
    '',
    team,
    ...tasks,
    '',
    open,
    '',
    next,
    ...section(
      'Decisions already made (do not relitigate them without new evidence):',
      pkg.decisions.map((decision) => `- ${decision}`)
    ),
    ...section(
      'Known risks:',
      pkg.risks.map((risk) => `- ${risk}`)
    ),
    ...section(
      'Branches of interest:',
      pkg.branchesOfInterest.map((branch) => `- ${branch}`)
    ),
    ...section(
      `Last events before the handoff (history only — start await_events at ${pkg.eventCursor}):`,
      pkg.recentEvents.slice(-SEED_RECENT_EVENTS_MAX).map(renderRecentEvent)
    ),
    ...(pkg.note ? ['', `Note from your predecessor: ${pkg.note}`] : [])
  ].join('\n')
}

export function buildSuccessorOrchestratorSystemPrompt(
  input: OrchestratorPromptInput,
  pkg: OrchestratorHandoffPackage
): string {
  return `${buildOrchestratorSystemPrompt(input)}\n\n${formatHandoffSeed(pkg)}`
}
