/**
 * Host-truth snapshot for the session chrome on a CLI window.
 *
 * The overlay does not parse a vendor TUI. It renders what the host already
 * knows: agent state, the worktree branch, open questions, and a short log
 * of workspace events that belong to this agent. Follow-ups and answers
 * take the same host paths the panel uses (`user_message` / `answer_question`),
 * so typing into the overlay cannot start a second brain in the TUI.
 */
import type { AgentEvent } from './schema/events'

export const CLI_SESSION_LOG_MAX = 40

export type CliSessionState = 'working' | 'waiting' | 'stopped'
export type CliSessionKind = 'orchestrator' | 'lead' | 'agent'

export interface CliSessionQuestion {
  questionId: string
  question: string
}

export type CliLogKind =
  | 'started'
  | 'progress'
  | 'question'
  | 'done'
  | 'stopped'
  | 'exited'
  | 'message'
  | 'user-question'
  | 'idle'

export interface CliLogEntry {
  kind: CliLogKind
  text: string
  ts: number
}

export interface CliSession {
  workspaceId: string
  state: CliSessionState
  kind: CliSessionKind
  /** Short branch name (`vertragus/limbo/bernardo`); absent when unknown. */
  branch?: string
  /** C5: orchestrator process alive but silent on its tools. */
  idle?: boolean
  pendingQuestion?: CliSessionQuestion
  /** D3: orchestrator `ask_user` — answered with the reserved agent id `user`. */
  userQuestion?: CliSessionQuestion
  log: CliLogEntry[]
}

export function sessionsEqual(left?: CliSession, right?: CliSession): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

/**
 * Map a workspace event ring onto the log this agent's window shows.
 *
 * Orchestrator windows see steering (`user_message`), `ask_user`, their own
 * idle watchdog, and events stamped with their agentId. Worker/lead windows
 * see only events for that agent, plus follow-ups that targeted them.
 * Child-team noise stays off this log — the panel card is the team view.
 */
export function sessionLogFromEvents(
  events: readonly AgentEvent[],
  agentId: string,
  isOrchestrator: boolean
): CliLogEntry[] {
  const entries: CliLogEntry[] = []
  for (const event of events) {
    const entry = logEntryFor(event, agentId, isOrchestrator)
    if (entry) entries.push(entry)
  }
  return entries.length > CLI_SESSION_LOG_MAX
    ? entries.slice(entries.length - CLI_SESSION_LOG_MAX)
    : entries
}

export function buildCliSession(input: {
  workspaceId: string
  agentId: string
  state: CliSessionState
  kind: CliSessionKind
  branch?: string
  idle?: boolean
  pendingQuestion?: CliSessionQuestion
  userQuestion?: CliSessionQuestion
  events: readonly AgentEvent[]
}): CliSession {
  return {
    workspaceId: input.workspaceId,
    state: input.state,
    kind: input.kind,
    ...(input.branch ? { branch: input.branch } : {}),
    ...(input.idle ? { idle: true } : {}),
    ...(input.pendingQuestion ? { pendingQuestion: input.pendingQuestion } : {}),
    ...(input.userQuestion ? { userQuestion: input.userQuestion } : {}),
    log: sessionLogFromEvents(input.events, input.agentId, input.kind === 'orchestrator')
  }
}

function logEntryFor(
  event: AgentEvent,
  agentId: string,
  isOrchestrator: boolean
): CliLogEntry | undefined {
  switch (event.type) {
    case 'user_message':
      if (!isOrchestrator && event.targetAgentId !== agentId) return undefined
      return { kind: 'message', text: event.text, ts: event.ts }
    case 'user_question':
      if (!isOrchestrator) return undefined
      return { kind: 'user-question', text: event.question, ts: event.ts }
    case 'orchestrator_idle':
      if (!isOrchestrator || event.agentId !== agentId) return undefined
      return { kind: 'idle', text: String(event.idleSec), ts: event.ts }
    case 'agent_started':
      if (event.agentId !== agentId) return undefined
      return { kind: 'started', text: event.model ?? event.providerId ?? '', ts: event.ts }
    case 'agent_progress':
      if (event.agentId !== agentId) return undefined
      return { kind: 'progress', text: event.note, ts: event.ts }
    case 'agent_question':
      if (event.agentId !== agentId) return undefined
      return { kind: 'question', text: event.question, ts: event.ts }
    case 'agent_done':
      if (event.agentId !== agentId) return undefined
      return { kind: 'done', text: event.summary, ts: event.ts }
    case 'agent_stopped':
      if (event.agentId !== agentId) return undefined
      return { kind: 'stopped', text: event.note ?? '', ts: event.ts }
    case 'agent_exited':
      if (event.agentId !== agentId) return undefined
      return {
        kind: 'exited',
        text: event.exitCode == null ? '' : String(event.exitCode),
        ts: event.ts
      }
    default:
      return undefined
  }
}
