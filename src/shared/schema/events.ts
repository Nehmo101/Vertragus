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
  'orchestrator_handoff_started',
  'orchestrator_started',
  'orchestrator_handoff_failed'
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

const orchestratorHandoffStartedPayload = z.object({
  type: z.literal('orchestrator_handoff_started'),
  ...identity,
  reason: z.enum(['context_full', 'long_run', 'user_requested', 'other']),
  eventCursor: z.number().int().nonnegative(),
  successorAgentId: z.string().min(1)
})

const orchestratorStartedPayload = z.object({
  type: z.literal('orchestrator_started'),
  ...identity,
  predecessorAgentId: z.string().min(1),
  eventCursor: z.number().int().nonnegative()
})

const orchestratorHandoffFailedPayload = z.object({
  type: z.literal('orchestrator_handoff_failed'),
  ...identity,
  message: z.string().min(1),
  successorAgentId: z.string().min(1).optional()
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
  orchestratorHandoffStartedPayload,
  orchestratorStartedPayload,
  orchestratorHandoffFailedPayload
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
  orchestratorHandoffStartedPayload.extend(envelope),
  orchestratorStartedPayload.extend(envelope),
  orchestratorHandoffFailedPayload.extend(envelope)
])
export type AgentEvent = z.infer<typeof agentEventSchema>

/** Narrow an event to one type without hand-written casts at call sites. */
export function isAgentEvent<T extends AgentEventType>(
  event: AgentEvent,
  type: T
): event is Extract<AgentEvent, { type: T }> {
  return event.type === type
}
