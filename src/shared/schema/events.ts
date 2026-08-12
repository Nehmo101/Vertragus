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
  'agent_done',
  'agent_question',
  'agent_progress',
  'agent_exited',
  'agent_stopped'
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

const agentDonePayload = z.object({
  type: z.literal('agent_done'),
  ...identity,
  summary: z.string(),
  status: agentDoneStatusSchema
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
   * must verify with `read_output` instead of assuming success.
   */
  confirmed: z.boolean()
})

const agentStoppedPayload = z.object({
  type: z.literal('agent_stopped'),
  ...identity,
  note: z.string().optional()
})

/** Event body as produced by a caller — no `seq`/`ts` yet. */
export const agentEventPayloadSchema = z.discriminatedUnion('type', [
  agentStartedPayload,
  agentDonePayload,
  agentQuestionPayload,
  agentProgressPayload,
  agentExitedPayload,
  agentStoppedPayload
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
  agentDonePayload.extend(envelope),
  agentQuestionPayload.extend(envelope),
  agentProgressPayload.extend(envelope),
  agentExitedPayload.extend(envelope),
  agentStoppedPayload.extend(envelope)
])
export type AgentEvent = z.infer<typeof agentEventSchema>

/** Narrow an event to one type without hand-written casts at call sites. */
export function isAgentEvent<T extends AgentEventType>(
  event: AgentEvent,
  type: T
): event is Extract<AgentEvent, { type: T }> {
  return event.type === type
}
