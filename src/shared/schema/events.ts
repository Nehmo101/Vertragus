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
import { questionChoicesFieldSchema } from '../questionChoices'

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
  'orchestrator_handoff_started',
  'orchestrator_started',
  'orchestrator_handoff_failed',
  'user_message',
  'user_question',
  'subtree_adopted',
  'integrate_ok',
  'integrate_conflict',
  'pull_request',
  'budget_warning'
] as const

export type AgentEventType = (typeof AGENT_EVENT_TYPES)[number]

/** Terminal outcome an agent reports for a task. */
export const AGENT_DONE_STATUSES = ['success', 'blocked', 'failed'] as const
export const agentDoneStatusSchema = z.enum(AGENT_DONE_STATUSES)
export type AgentDoneStatus = (typeof AGENT_DONE_STATUSES)[number]

/** Any JSON value — what a structured `agent_done.result` may carry. */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }

/**
 * S3: recursive schema for {@link JsonValue}. The event layer only guards
 * "this is JSON" — the SHAPE was already enforced by `report_done` against the
 * `start_agent{resultSchema}` before the event was pushed.
 */
export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(jsonValueSchema)
  ])
)

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
  branch: z.string().min(1).optional(),
  /**
   * Direct parent in the live tree (lead for a worker, worker for a helper).
   * Absent on root children and on every journal written before A1.
   */
  parentId: z.string().min(1).max(200).optional(),
  /** First line of the assignment, capped — lane label when the role name is not enough. */
  taskSubject: z.string().min(1).max(200).optional()
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
   * S3: the agent's structured report — validated against the
   * `start_agent{resultSchema}` (when one was registered) BEFORE the event is
   * pushed, so a reader can trust the shape without re-validating.
   */
  result: jsonValueSchema.optional(),
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
  question: z.string().min(1),
  /** Short labels for a decision; absent = text-only (or parse fallback). */
  choices: questionChoicesFieldSchema.optional()
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
 * D2: the human steered the run from the panel or the remote client. No
 * sender identity — the sender is the user, who is not an agent. Optional
 * target/relay fields name a team member to pass the instruction to; they
 * do not make the user an agent. Pushing it is what wakes a parked
 * `await_events`.
 */
const userMessagePayload = z.object({
  type: z.literal('user_message'),
  text: z.string().min(1).max(20_000),
  /**
   * Optional addressee among the team. Absent = steer the orchestrator in
   * general. The SENDER is still the human — this is not agent identity.
   */
  targetAgentId: z.string().min(1).max(200).optional(),
  targetName: z.string().min(1).max(200).optional(),
  /**
   * When the addressee is not a direct child of the root, the orchestrator
   * cannot send_to_agent it (fan-in). Relay through this root-level parent.
   */
  relayViaAgentId: z.string().min(1).max(200).optional(),
  relayViaName: z.string().min(1).max(200).optional()
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
  question: z.string().min(1),
  /** Short labels for a decision; absent = text-only (or parse fallback). */
  choices: questionChoicesFieldSchema.optional()
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

/**
 * E1: the host merged `branch` into the target agent's worktree — or aborted
 * on conflict, leaving the worktree clean and naming the conflicting files.
 * Identity is the TARGET agent (whose checkout was merged into).
 */
const integrateOkPayload = z.object({
  type: z.literal('integrate_ok'),
  ...identity,
  branch: z.string().min(1),
  headSha: z.string().min(1),
  /**
   * A3: where the merge landed — an agent's worktree (the `integrate_branch`
   * default) or the repository's own checkout (an automated Promote). Absent
   * on every event written before A3, which were all worktree merges.
   */
  target: z.enum(['worktree', 'checkout']).optional()
})

const integrateConflictPayload = z.object({
  type: z.literal('integrate_conflict'),
  ...identity,
  branch: z.string().min(1),
  conflictFiles: z.array(z.string().min(1).max(400)).max(80),
  message: z.string().max(2_000),
  /** A3: see {@link integrateOkPayload}. */
  target: z.enum(['worktree', 'checkout']).optional()
})

/**
 * A3: the host opened (or failed to open) the run's pull request — the
 * `automation.autoPr` path. Not agent-scoped: the pull request belongs to the
 * run, not to whichever agent reported last. `ok: false` still carries a
 * usable sentence and, whenever the branch reached the remote, the compare URL
 * the user can click instead.
 */
const pullRequestPayload = z.object({
  type: z.literal('pull_request'),
  ok: z.boolean(),
  /** Branch the pull request was opened from. */
  branch: z.string().min(1),
  base: z.string().min(1),
  /** The pull request URL, or the compare URL when the host could not open it. */
  url: z.string().max(500).optional(),
  message: z.string().max(2_000).optional()
})

/**
 * E4: the workspace burned through its runtime budget (sum of agent-seconds
 * against `maxRuntimeMin`). Pushed once per threshold; new starts are refused
 * once the budget is exhausted. A wall clock, never a guessed token counter.
 */
const budgetWarningPayload = z.object({
  type: z.literal('budget_warning'),
  usedSec: z.number().int().nonnegative(),
  limitSec: z.number().int().positive(),
  /** True once new agent starts are refused. */
  exhausted: z.boolean()
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
  orchestratorIdlePayload,
  orchestratorHandoffStartedPayload,
  orchestratorStartedPayload,
  orchestratorHandoffFailedPayload,
  userMessagePayload,
  userQuestionPayload,
  subtreeAdoptedPayload,
  integrateOkPayload,
  integrateConflictPayload,
  pullRequestPayload,
  budgetWarningPayload
])
export type AgentEventPayload = z.infer<typeof agentEventPayloadSchema>

const envelope = {
  /** Strictly increasing per workspace, starting at 1. */
  seq: z.number().int().positive(),
  /** Unix epoch milliseconds. */
  ts: z.number().int().nonnegative(),
  /**
   * S2: true = does not wake a parked `await_events`; rides along with the
   * next wake. Stamped by the queue for pure echo events whose data the
   * caller already got synchronously. Optional so old journals stay valid.
   */
  quiet: z.literal(true).optional()
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
  orchestratorHandoffStartedPayload.extend(envelope),
  orchestratorStartedPayload.extend(envelope),
  orchestratorHandoffFailedPayload.extend(envelope),
  userMessagePayload.extend(envelope),
  userQuestionPayload.extend(envelope),
  subtreeAdoptedPayload.extend(envelope),
  integrateOkPayload.extend(envelope),
  integrateConflictPayload.extend(envelope),
  pullRequestPayload.extend(envelope),
  budgetWarningPayload.extend(envelope)
])
export type AgentEvent = z.infer<typeof agentEventSchema>

/** Narrow an event to one type without hand-written casts at call sites. */
export function isAgentEvent<T extends AgentEventType>(
  event: AgentEvent,
  type: T
): event is Extract<AgentEvent, { type: T }> {
  return event.type === type
}
