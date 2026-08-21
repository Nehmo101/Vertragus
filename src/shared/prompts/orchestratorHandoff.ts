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

/**
 * C6 crash recovery: the same package, read back from disk after the whole
 * host died mid-handoff. Everything the package says about PROCESSES is dead
 * by then — the queue this successor polls is a new one starting at 0, the
 * ticket ids belong to waiters that no longer exist, and the roster lists
 * agents whose CLIs are gone. What survives is on disk: branches, worktrees,
 * the task board, and what the predecessor wrote down. A seed that did not say
 * that would send a fresh orchestrator to answer questions nobody is waiting
 * for.
 */
export interface HandoffSeedOptions {
  recovered?: boolean
}

export function formatHandoffSeed(
  pkg: OrchestratorHandoffPackage,
  options: HandoffSeedOptions = {}
): string {
  const recovered = options.recovered === true
  const goal =
    pkg.goal?.current || pkg.goal?.original
      ? `Current goal: ${pkg.goal.current ?? pkg.goal.original}`
      : 'Current goal: (not recorded — confirm with the user if unclear).'
  const open =
    pkg.openQuestions.length === 0
      ? 'No open agent questions.'
      : recovered
        ? [
            'These questions were open when the old run died. They are VOID: the agents that asked ' +
              'them are gone, their question ids answer nothing, and send_to_agent will fail on them. ' +
              'Treat them as open QUESTIONS, not as open tickets — decide them yourself, ask the user ' +
              'with ask_user, or re-ask a fresh agent:',
            ...pkg.openQuestions.map((question) => `- ${question.agentId}: ${question.question}`)
          ].join('\n')
        : [
            'Open questions (answer these first with send_to_agent{questionId}):',
            ...pkg.openQuestions.map(
              (question) => `- ${question.agentId} [${question.questionId}]: ${question.question}`
            )
          ].join('\n')
  const next =
    pkg.nextActions.length === 0
      ? recovered
        ? 'No next-actions were recorded — read task_list and the branches above, then continue the goal.'
        : 'No next-actions were recorded — inspect list_agents and continue the goal.'
      : ['Next actions:', ...pkg.nextActions.map((action) => `- ${action}`)].join('\n')
  const team =
    pkg.agents.length === 0
      ? recovered
        ? 'That run had no subagents left when it died.'
        : 'No subagents are running for you right now — list_agents will confirm.'
      : [
          recovered
            ? 'The team of the dead run. None of these processes is alive; what survived is their ' +
              'branches and worktrees — continue on them with start_agent{baseBranch: "<branch>"} ' +
              'instead of redoing the work, and verify a report before trusting it:'
            : 'Your team right now (host roster at handoff — these agents keep working for YOU):',
          ...pkg.agents.map((agent) => {
            const parts = [`- ${agent.name} [${agent.agentId}] (${agent.role}, ${agent.status})`]
            if (agent.branch) parts.push(`branch ${agent.branch}`)
            if (agent.pendingQuestionId) {
              parts.push(
                recovered
                  ? 'was waiting on an answer when the run died'
                  : `waiting on your answer to question ${agent.pendingQuestionId}`
              )
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
          recovered
            ? 'The task board is HOST state and survived on disk — task_list shows it; do not rebuild it from prose. Tasks that were in_progress are back to pending because their owners are gone:'
            : 'The task board is HOST state and survived this handoff — task_list shows it; do not rebuild it from prose:',
          ...pkg.tasks.map(
            (task) =>
              `- ${task.taskId} rev ${task.revision} (${task.status}${
                task.ownerAgentId ? `, owner ${task.ownerAgentId}` : ''
              }${task.blockedBy.length > 0 ? `, blockedBy ${task.blockedBy.join(',')}` : ''}): ${task.subject}`
          )
        ]

  const head = recovered
    ? [
        `You are recovering the run of ${pkg.predecessor.name} in workspace "${pkg.workspaceName}".`,
        'That run was handing over to a successor when the host died; this package is what it froze ' +
          'before dying, and you are the successor it never got. Continue the work, do not restart it.',
        'Nothing of that run is still RUNNING: no CLI, no event queue, no pending ticket. Everything ' +
          'below that survived is on disk — branches, worktrees, the task board, past runs ' +
          '(search_runs).',
        'Do not call record_retro until the goal is actually reached.',
        '',
        goal,
        `Start await_events at cursor 0. This workspace has a NEW event queue; cursor ${pkg.eventCursor} ` +
          'belonged to the dead one and means nothing here.',
        'Trust the branches and inspect_agent over the prose below when they disagree — every report ' +
          'in this package is a claim from a process that is no longer there to defend it.'
      ]
    : [
        `You are the successor of ${pkg.predecessor.name} in workspace "${pkg.workspaceName}".`,
        'This is a continuation of the same run, not a new one. Do not restart the work from scratch.',
        'Do not call record_retro until the goal is actually reached.',
        '',
        goal,
        `Your first await_events MUST use cursor ${pkg.eventCursor} (package.eventCursor). Do not start at 0.`,
        'Trust host facts in this package and on agent_done / inspect_agent over prose when they disagree.'
      ]

  return [
    ...head,
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
      recovered
        ? 'Last events of that run (history only — this queue starts at 0):'
        : `Last events before the handoff (history only — start await_events at ${pkg.eventCursor}):`,
      pkg.recentEvents.slice(-SEED_RECENT_EVENTS_MAX).map(renderRecentEvent)
    ),
    ...(pkg.note ? ['', `Note from your predecessor: ${pkg.note}`] : [])
  ].join('\n')
}

export function buildSuccessorOrchestratorSystemPrompt(
  input: OrchestratorPromptInput,
  pkg: OrchestratorHandoffPackage,
  options: HandoffSeedOptions = {}
): string {
  return `${buildOrchestratorSystemPrompt(input)}\n\n${formatHandoffSeed(pkg, options)}`
}
