/**
 * Workspace event schema — the single vocabulary the orchestrator observes.
 *
 * Every event carries an envelope (`seq`, `ts`) that the EventQueue stamps on
 * push; producers only ever supply the payload. `seq` is a strictly increasing
 * per-workspace cursor, which is what makes `await_events` idempotent: a reader
 * asks for "everything after seq N" and can safely re-ask with the same cursor
 * (at-least-once delivery, duplicate-free reads).
 */
import { z } from 'zod'

export const AGENT_EVENT_TYPES = [
  'agent_started',
  'agent_start_failed',
  'agent_done',
  'agent_question',
  'agent_progress',
  'agent_exited',
  'agent_stopped',
  'orchestrator_exited',
  'orchestrator_idle',
  'user_message',
  'user_question',
  'subtree_adopted'
] as const

export type AgentEventType = (typeof AGENT_EVENT_TYPES)[number]

/** Terminal outcome an agent reports for a task. */
export const AGENT_DONE_STATUSES = ['success', 'blocked', 'failed'] as const
export const agentDoneStatusSchema = z.enum(AGENT_DONE_STATUSES)
export type AgentDoneStatus = (typeof AGENT_DONE_STATUSES)[number]

/** Identity fields every event repeats so a reader never needs a side lookup. */
const identity = {
  agentId: z.string().min(1),
  name: z.string().min(1),
  roleId: z.string().min(1)
}

const agentStartedPayload = z.object({
  type: z.literal('agent_started'),
  ...identity,
  /** Effective provider id — resolved from the slot, not the tool input. */
  providerId: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  worktreePath: z.string().min(1).optional(),
  /** The agent's own branch — what `start_agent{baseBranch}` chains from. */
  branch: z.string().min(1).optional()
})

/**
 * A start that was reserved (the `start_agent` call already returned the
 * agentId) but never came up: worktree creation, spawn or the seed handshake
 * failed. The reservation is released — the slot is free again. The agentId
 * is dead from here on; a retry is a fresh `start_agent`.
 */
const agentStartFailedPayload = z.object({
  type: z.literal('agent_start_failed'),
  ...identity,
  message: z.string()
})

const agentDonePayload = z.object({
  type: z.literal('agent_done'),
  ...identity,
  summary: z.string(),
  status: agentDoneStatusSchema,
  /**
   * Host-truth from the agent's worktree at report time. Absent when git
   * failed — the summary still stands; the orchestrator then uses inspect_agent.
   */
  branch: z.string().min(1).optional(),
  headSha: z.string().min(1).optional(),
  uncommitted: z.boolean().optional(),
  changedFiles: z.array(z.string().min(1).max(400)).max(80).optional(),
  diffStat: z.string().max(850).optional()
})

const agentQuestionPayload = z.object({
  type: z.literal('agent_question'),
  ...identity,
  questionId: z.string().min(1),
  question: z.string().min(1)
})

const agentProgressPayload = z.object({
  type: z.literal('agent_progress'),
  ...identity,
  note: z.string()
})

const agentExitedPayload = z.object({
  type: z.literal('agent_exited'),
  ...identity,
  exitCode: z.number().int().nullable().optional(),
  /**
   * `true` only when the agent reported a terminal result before the process
   * ended. `false` means the process vanished unconfirmed — the orchestrator
   * must verify with `read_output` instead of assuming success. File changes
   * are verified with `inspect_agent`, not the terminal tail.
   */
  confirmed: z.boolean()
})

const agentStoppedPayload = z.object({
  type: z.literal('agent_stopped'),
  ...identity,
  note: z.string().optional()
})

/**
 * The workspace's own orchestrator died unasked — a crash, a `/exit`, an OOM
 * kill. The workspace is no longer driving itself: subagents keep running, but
 * nobody reads their events until the user intervenes. There is no `confirmed`
 * here — the orchestrator reports to the user, not to a contract.
 */
const orchestratorExitedPayload = z.object({
  type: z.literal('orchestrator_exited'),
  ...identity,
  exitCode: z.number().int().nullable().optional()
})

/**
 * C5: the orchestrator PROCESS is alive but has stopped calling its tools —
 * the other death, distinct from `orchestrator_exited`. A parked
 * `await_events` long-poll is NOT idle (its call touched the watchdog); idle
 * means no tool call started or finished for the whole window. The event is
 * for the panel, the remote client and the history — the orchestrator itself
 * is the one reader that will not see it (it stopped reading), so nothing
 * here tries to wake it.
 */
const orchestratorIdlePayload = z.object({
  type: z.literal('orchestrator_idle'),
  ...identity,
  /** Seconds since the last orchestrator tool call when the watchdog fired. */
  idleSec: z.number().int().nonnegative()
})

/**
 * D2: the human steered the run from the panel or the remote client. No agent
 * identity — the sender is the user, who is not an agent. Pushing it is what
 * wakes a parked `await_events`, so the orchestrator reads the steering
 * immediately instead of after its next poll window.
 */
const userMessagePayload = z.object({
  type: z.literal('user_message'),
  text: z.string().min(1).max(20_000)
})

/**
 * D3: the orchestrator asked the HUMAN a question (`ask_user`) and is blocked
 * on the answer. The registry entry behind `questionId` is what the panel /
 * remote answer path resolves; the event is the badge's push signal and the
 * history record. No agent identity — the addressee is the user.
 */
const userQuestionPayload = z.object({
  type: z.literal('user_question'),
  questionId: z.string().min(1),
  question: z.string().min(1)
})

/**
 * F: a lead orchestrator died (or was stopped) and its still-running children
 * were REPARENTED to the root — their future events now land in the root
 * queue. Only in the failure case does the root see more events; that is the
 * deal. Past subtree events are NOT replayed (the retro tap already recorded
 * them); the root inspects the adopted agents instead.
 */
const subtreeAdoptedPayload = z.object({
  type: z.literal('subtree_adopted'),
  /** The dead lead. */
  leadAgentId: z.string().min(1),
  area: z.string().min(1).max(200),
  /** The reparented children — direct children of the root from now on. */
  adoptedAgentIds: z.array(z.string().min(1)).max(200)
})

/** Event body as produced by a caller — no `seq`/`ts` yet. */
export const agentEventPayloadSchema = z.discriminatedUnion('type', [
  agentStartedPayload,
  agentStartFailedPayload,
  agentDonePayload,
  agentQuestionPayload,
  agentProgressPayload,
  agentExitedPayload,
  agentStoppedPayload,
  orchestratorExitedPayload,
  orchestratorIdlePayload,
  userMessagePayload,
  userQuestionPayload,
  subtreeAdoptedPayload
])
export type AgentEventPayload = z.infer<typeof agentEventPayloadSchema>

const envelope = {
  /** Strictly increasing per workspace, starting at 1. */
  seq: z.number().int().positive(),
  /** Unix epoch milliseconds. */
  ts: z.number().int().nonnegative()
}

export const agentEventSchema = z.discriminatedUnion('type', [
  agentStartedPayload.extend(envelope),
  agentStartFailedPayload.extend(envelope),
  agentDonePayload.extend(envelope),
  agentQuestionPayload.extend(envelope),
  agentProgressPayload.extend(envelope),
  agentExitedPayload.extend(envelope),
  agentStoppedPayload.extend(envelope),
  orchestratorExitedPayload.extend(envelope),
  orchestratorIdlePayload.extend(envelope),
  userMessagePayload.extend(envelope),
  userQuestionPayload.extend(envelope),
  subtreeAdoptedPayload.extend(envelope)
])
export type AgentEvent = z.infer<typeof agentEventSchema>

/** Narrow an event to one type without hand-written casts at call sites. */
export function isAgentEvent<T extends AgentEventType>(
  event: AgentEvent,
  type: T
): event is Extract<AgentEvent, { type: T }> {
  return event.type === type
}
