/**
 * Orchestrator succession package — the structured brief a successor root
 * receives when the incumbent's context is exhausted.
 *
 * Host-computed fields (roster, open questions, eventCursor, git facts) are
 * the truth. Orchestrator-written fields (goal, decisions, nextActions) are
 * hints and are truncated first when the package hits the size cap.
 */
import { z } from 'zod'

export const SUCCESSION_REASONS = [
  'context_full',
  'long_run',
  'user_requested',
  'other'
] as const
export const successionReasonSchema = z.enum(SUCCESSION_REASONS)
export type SuccessionReason = z.infer<typeof successionReasonSchema>

export const GOAL_MAX_CHARS = 2_000
export const NOTE_MAX_CHARS = 300
export const QUESTION_MAX_CHARS = 2_000
export const AGENT_SUMMARY_MAX_CHARS = 500
export const AGENT_FILES_MAX = 20
export const DECISIONS_MAX = 15
export const RISKS_MAX = 10
export const NEXT_ACTIONS_MAX = 10
export const RECENT_EVENTS_MAX = 40
export const PACKAGE_MAX_CHARS = 48_000

const cappedString = (max: number) => z.string().max(max)

export const handoffGoalSchema = z
  .object({
    original: cappedString(GOAL_MAX_CHARS).optional(),
    current: cappedString(GOAL_MAX_CHARS).optional()
  })
  .strict()
export type HandoffGoal = z.infer<typeof handoffGoalSchema>

export const handoffAgentNoteSchema = z
  .object({
    agentId: z.string().min(1),
    note: cappedString(NOTE_MAX_CHARS)
  })
  .strict()

export const handoffAgentSchema = z
  .object({
    agentId: z.string().min(1),
    name: z.string().min(1),
    role: z.string().min(1),
    status: z.string().min(1),
    model: z.string().min(1).optional(),
    worktreePath: z.string().min(1).optional(),
    branch: z.string().min(1).optional(),
    headSha: z.string().min(1).optional(),
    uncommitted: z.boolean().optional(),
    lastSummary: cappedString(AGENT_SUMMARY_MAX_CHARS).optional(),
    changedFiles: z.array(z.string().min(1).max(400)).max(AGENT_FILES_MAX).optional(),
    orchNote: cappedString(NOTE_MAX_CHARS).optional(),
    pendingQuestionId: z.string().min(1).optional(),
    pendingQuestion: z.string().min(1).optional()
  })
  .strict()
export type HandoffAgent = z.infer<typeof handoffAgentSchema>

/** S4: max subject characters carried per task row in the package. */
export const TASK_SUBJECT_MAX_CHARS = 200

/**
 * S4: one task-board row in the package. Like `openQuestions`, tasks are NEVER
 * truncated away by the size cap — the board is the plan, and a successor that
 * loses it rebuilds it from prose, which is exactly the failure S4 removes.
 * The full board stays host state anyway (task_list); these rows seed trust.
 */
export const handoffTaskSchema = z
  .object({
    taskId: z.string().min(1),
    revision: z.number().int().positive(),
    subject: cappedString(TASK_SUBJECT_MAX_CHARS),
    status: z.string().min(1),
    ownerAgentId: z.string().min(1).optional(),
    blockedBy: z.array(z.string())
  })
  .strict()
export type HandoffTask = z.infer<typeof handoffTaskSchema>

export const handoffOpenQuestionSchema = z
  .object({
    questionId: z.string().min(1),
    agentId: z.string().min(1),
    question: cappedString(QUESTION_MAX_CHARS)
  })
  .strict()
export type HandoffOpenQuestion = z.infer<typeof handoffOpenQuestionSchema>

export const handoffRecentEventSchema = z
  .object({
    seq: z.number().int().positive(),
    type: z.string().min(1),
    agentId: z.string().min(1).optional(),
    name: z.string().min(1).optional(),
    roleId: z.string().min(1).optional(),
    summary: z.string().max(AGENT_SUMMARY_MAX_CHARS).optional(),
    questionId: z.string().min(1).optional(),
    question: z.string().max(QUESTION_MAX_CHARS).optional(),
    status: z.string().min(1).optional(),
    message: z.string().max(GOAL_MAX_CHARS).optional()
  })
  .strict()
export type HandoffRecentEvent = z.infer<typeof handoffRecentEventSchema>

export const handoffPredecessorSchema = z
  .object({
    agentId: z.string().min(1),
    name: z.string().min(1),
    providerId: z.string().min(1),
    model: z.string().min(1).optional()
  })
  .strict()

export const handoffOrchWorktreeSchema = z
  .object({
    dirty: z.boolean(),
    changedFiles: z.array(z.string().min(1).max(400)).max(AGENT_FILES_MAX)
  })
  .strict()

export const orchestratorHandoffPackageSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal('orchestrator_succession'),
    workspaceId: z.string().min(1),
    workspaceName: z.string().min(1),
    profileId: z.string().min(1),
    createdAt: z.number().int().nonnegative(),
    reason: successionReasonSchema,
    predecessor: handoffPredecessorSchema,
    successorAgentId: z.string().min(1),
    goal: handoffGoalSchema.optional(),
    eventCursor: z.number().int().nonnegative(),
    recentEvents: z.array(handoffRecentEventSchema).max(RECENT_EVENTS_MAX),
    agents: z.array(handoffAgentSchema),
    openQuestions: z.array(handoffOpenQuestionSchema),
    tasks: z.array(handoffTaskSchema),
    decisions: z.array(cappedString(NOTE_MAX_CHARS)).max(DECISIONS_MAX),
    risks: z.array(cappedString(NOTE_MAX_CHARS)).max(RISKS_MAX),
    nextActions: z.array(cappedString(NOTE_MAX_CHARS)).max(NEXT_ACTIONS_MAX),
    branchesOfInterest: z.array(z.string().min(1).max(300)).max(20),
    orchWorktree: handoffOrchWorktreeSchema.optional(),
    note: cappedString(GOAL_MAX_CHARS).optional(),
    limits: z
      .object({
        maxChars: z.number().int().positive(),
        truncated: z.array(z.string().min(1))
      })
      .strict()
  })
  .strict()
export type OrchestratorHandoffPackage = z.infer<typeof orchestratorHandoffPackageSchema>

/** What the incumbent orchestrator may supply; the host fills the rest. */
export const successionRequestSchema = z
  .object({
    reason: successionReasonSchema,
    goal: handoffGoalSchema.optional(),
    decisions: z.array(z.string().min(1).max(1_000)).max(DECISIONS_MAX).optional(),
    risks: z.array(z.string().min(1).max(1_000)).max(RISKS_MAX).optional(),
    nextActions: z.array(z.string().min(1).max(1_000)).max(NEXT_ACTIONS_MAX).optional(),
    agentNotes: z.array(handoffAgentNoteSchema).max(32).optional(),
    note: z.string().min(1).max(GOAL_MAX_CHARS).optional()
  })
  .strict()
export type SuccessionRequest = z.infer<typeof successionRequestSchema>

export function capText(text: string, max: number): { value: string; truncated: boolean } {
  if (text.length <= max) return { value: text, truncated: false }
  if (max <= 1) return { value: '…', truncated: true }
  return { value: `${text.slice(0, max - 1)}…`, truncated: true }
}

export function capList(values: readonly string[], maxItems: number, maxChars: number): {
  values: string[]
  truncated: boolean
} {
  const sliced = values.slice(0, maxItems)
  let truncated = sliced.length < values.length
  const capped = sliced.map((entry) => {
    const result = capText(entry, maxChars)
    if (result.truncated) truncated = true
    return result.value
  })
  return { values: capped, truncated }
}

const PREFERRED_EVENT_TYPES = new Set([
  'agent_done',
  'agent_question',
  'agent_exited',
  'agent_start_failed',
  'agent_stopped',
  'orchestrator_handoff_started',
  'orchestrator_handoff_failed',
  'orchestrator_started'
])

export interface RecentEventSource {
  seq: number
  type: string
  agentId?: string
  name?: string
  roleId?: string
  summary?: string
  questionId?: string
  question?: string
  status?: string
  message?: string
}

/** Compact a live event stream into the package's recentEvents list. */
export function compactRecentEvents(events: readonly RecentEventSource[]): HandoffRecentEvent[] {
  const preferred = events.filter((event) => PREFERRED_EVENT_TYPES.has(event.type))
  const source = preferred.length > 0 ? preferred : events
  return source.slice(-RECENT_EVENTS_MAX).map((event) => {
    const row: HandoffRecentEvent = { seq: event.seq, type: event.type }
    if (event.agentId) row.agentId = event.agentId
    if (event.name) row.name = event.name
    if (event.roleId) row.roleId = event.roleId
    if (event.summary) row.summary = capText(event.summary, AGENT_SUMMARY_MAX_CHARS).value
    if (event.questionId) row.questionId = event.questionId
    if (event.question) row.question = capText(event.question, QUESTION_MAX_CHARS).value
    if (event.status) row.status = event.status
    if (event.message) row.message = capText(event.message, GOAL_MAX_CHARS).value
    return row
  })
}

export interface BuildHandoffPackageInput {
  workspaceId: string
  workspaceName: string
  profileId: string
  createdAt: number
  reason: SuccessionReason
  predecessor: z.infer<typeof handoffPredecessorSchema>
  successorAgentId: string
  eventCursor: number
  agents: HandoffAgent[]
  openQuestions: HandoffOpenQuestion[]
  /** S4: the task board at handoff; absent = a run without a board (old fakes). */
  tasks?: HandoffTask[]
  recentEvents: HandoffRecentEvent[]
  goal?: HandoffGoal
  decisions?: string[]
  risks?: string[]
  nextActions?: string[]
  branchesOfInterest?: string[]
  orchWorktree?: z.infer<typeof handoffOrchWorktreeSchema>
  note?: string
}

function capGoal(goal: HandoffGoal | undefined, truncated: string[]): HandoffGoal | undefined {
  if (!goal) return undefined
  const original = goal.original ? capText(goal.original, GOAL_MAX_CHARS) : undefined
  const current = goal.current ? capText(goal.current, GOAL_MAX_CHARS) : undefined
  if (original?.truncated || current?.truncated) truncated.push('goal')
  if (!original && !current) return undefined
  return {
    ...(original ? { original: original.value } : {}),
    ...(current ? { current: current.value } : {})
  }
}

/**
 * Assemble and size-cap a succession package. Open questions and agent ids are
 * never dropped; orch prose and recentEvents shrink first.
 */
export function buildHandoffPackage(input: BuildHandoffPackageInput): OrchestratorHandoffPackage {
  const truncated: string[] = []
  const decisions = capList(input.decisions ?? [], DECISIONS_MAX, NOTE_MAX_CHARS)
  const risks = capList(input.risks ?? [], RISKS_MAX, NOTE_MAX_CHARS)
  const nextActions = capList(input.nextActions ?? [], NEXT_ACTIONS_MAX, NOTE_MAX_CHARS)
  if (decisions.truncated) truncated.push('decisions')
  if (risks.truncated) truncated.push('risks')
  if (nextActions.truncated) truncated.push('nextActions')

  const note = input.note ? capText(input.note, GOAL_MAX_CHARS) : undefined
  if (note?.truncated) truncated.push('note')

  const openQuestions = input.openQuestions.map((question) => {
    const capped = capText(question.question, QUESTION_MAX_CHARS)
    if (capped.truncated) truncated.push('openQuestions.text')
    return { ...question, question: capped.value }
  })

  // S4: subjects are capped, rows are not — tasks survive the size cap whole,
  // like openQuestions (see handoffTaskSchema).
  const tasks = (input.tasks ?? []).map((task) => {
    const capped = capText(task.subject, TASK_SUBJECT_MAX_CHARS)
    if (capped.truncated) truncated.push('tasks.subject')
    return { ...task, subject: capped.value }
  })

  const recentEvents = compactRecentEvents(input.recentEvents)
  if (recentEvents.length < input.recentEvents.length) truncated.push('recentEvents')

  const pkg: OrchestratorHandoffPackage = {
    schemaVersion: 1,
    kind: 'orchestrator_succession',
    workspaceId: input.workspaceId,
    workspaceName: input.workspaceName,
    profileId: input.profileId,
    createdAt: input.createdAt,
    reason: input.reason,
    predecessor: input.predecessor,
    successorAgentId: input.successorAgentId,
    eventCursor: input.eventCursor,
    recentEvents,
    agents: input.agents,
    openQuestions,
    tasks,
    decisions: decisions.values,
    risks: risks.values,
    nextActions: nextActions.values,
    branchesOfInterest: (input.branchesOfInterest ?? []).slice(0, 20),
    limits: { maxChars: PACKAGE_MAX_CHARS, truncated }
  }
  const goal = capGoal(input.goal, truncated)
  if (goal) pkg.goal = goal
  if (input.orchWorktree) pkg.orchWorktree = input.orchWorktree
  if (note) pkg.note = note.value

  let serialized = JSON.stringify(pkg)
  while (serialized.length > PACKAGE_MAX_CHARS && pkg.recentEvents.length > 0) {
    pkg.recentEvents = pkg.recentEvents.slice(1)
    if (!pkg.limits.truncated.includes('recentEvents')) pkg.limits.truncated.push('recentEvents')
    serialized = JSON.stringify(pkg)
  }
  while (serialized.length > PACKAGE_MAX_CHARS && pkg.decisions.length > 0) {
    pkg.decisions = pkg.decisions.slice(0, -1)
    if (!pkg.limits.truncated.includes('decisions')) pkg.limits.truncated.push('decisions')
    serialized = JSON.stringify(pkg)
  }
  return orchestratorHandoffPackageSchema.parse(pkg)
}
