/**
 * The tools the orchestrator agent gets. Everything the orchestrator can
 * do to the world goes through here — there is no second path.
 *
 * The tools deliberately do very little themselves: check the limits, compose
 * the contract, translate host results into JSON, and push the lifecycle events
 * the orchestrator later reads back through `await_events`.
 */
import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { parseNewAskChoices, questionChoicesToolFieldSchema } from '@shared/questionChoices'
import { buildHandoffBlock, buildReminderSuffix, buildTaskContract } from '@shared/prompts/contract'
import { successionRequestSchema } from '@shared/schema/handoff'
import { searchRuns } from '@main/workspace/searchRuns'
import {
  assertSupportedResultSchema,
  ResultSchemaError,
  RESULT_SCHEMA_MAX_CHARS,
  type ResultSchema
} from '@shared/schema/resultSchema'
import { TASK_STATUSES, type Task } from '@shared/schema/tasks'
import { TASK_ACTIONS, type TaskBoard, type TaskBoardFailure } from '@main/workspace/taskBoard'
import { answerAgentQuestion } from './answerQuestion'
import { resolveAskTimeoutMs, SUBAGENT_TOOL_NAMES } from './toolsSubagent'
import {
  errorMessage,
  inScope,
  INSPECT_VIEWS,
  MAX_HELPERS_PER_WORKER,
  MAX_LEADS,
  attachSubtreeAdoptionTap,
  canSpawnHelpers,
  ensureNest,
  queueForAgent,
  recordAssignment,
  runningAgents,
  slimAgentsSummary,
  summarizeAgents,
  toolError,
  toolJson,
  toolText,
  USER_QUESTION_AGENT_ID,
  type LeadRuntime,
  type StartingAgent,
  type RunPullRequest,
  type ToolText,
  type WorkspaceRuntime
} from './types'
import { EventQueue } from './eventQueue'

/** First line of an assignment, capped to the event schema's taskSubject max. */
const TASK_SUBJECT_MAX = 200

function taskSubjectOf(task: string): string | undefined {
  const line = task.split('\n').find((row) => row.trim())?.trim()
  if (!line) return undefined
  return line.length <= TASK_SUBJECT_MAX ? line : line.slice(0, TASK_SUBJECT_MAX)
}

function agentStartedEvent(
  started: StartingAgent,
  runtime: WorkspaceRuntime,
  task: string
): {
  type: 'agent_started'
  agentId: string
  name: string
  roleId: string
  providerId?: string
  model?: string
  worktreePath?: string
  branch?: string
  parentId?: string
  taskSubject?: string
} {
  const parentId = runtime.parentOf.get(started.agentId)
  const taskSubject = taskSubjectOf(task)
  return {
    type: 'agent_started',
    agentId: started.agentId,
    name: started.name,
    roleId: started.role,
    providerId: started.providerId,
    model: started.model,
    worktreePath: started.worktreePath,
    branch: started.branch,
    ...(parentId ? { parentId } : {}),
    ...(taskSubject ? { taskSubject } : {})
  }
}

/**
 * Bare names of every orchestrator tool. The launch allowlist and the invariant
 * test derive from this list — a tool registered but missing here would be
 * invisible to strict-allowlist providers like Claude.
 */
export const ORCHESTRATOR_TOOL_NAMES = [
  'start_agent',
  'send_to_agent',
  'await_events',
  'list_agents',
  'stop_agent',
  'read_output',
  'inspect_agent',
  'integrate_branch',
  'ask_user',
  'start_orchestrator',
  'record_retro',
  'request_succession',
  'search_runs',
  'task_create',
  'task_update',
  'task_list'
] as const

export type OrchestratorToolName = (typeof ORCHESTRATOR_TOOL_NAMES)[number]

/**
 * F: the tools a LEAD identity gets — downward the scoped orchestration
 * subset (no ask_user, no record_retro, no start_orchestrator: depth stays
 * exactly 1), upward the three subagent tools. Union by design.
 */
export const LEAD_TOOL_NAMES = [
  'start_agent',
  'send_to_agent',
  'await_events',
  'list_agents',
  'stop_agent',
  'read_output',
  'inspect_agent',
  'integrate_branch',
  'task_create',
  'task_update',
  'task_list',
  ...SUBAGENT_TOOL_NAMES
] as const

export type LeadToolName = (typeof LEAD_TOOL_NAMES)[number]

/**
 * Downward tools a worker that may spawn helpers gets — the lead subset minus
 * the shared task board (the board stays root/lead territory). Upward tools
 * stay on {@link SUBAGENT_TOOL_NAMES}; browser tools are registered separately.
 */
export const WORKER_DOWN_TOOL_NAMES = [
  'start_agent',
  'send_to_agent',
  'await_events',
  'list_agents',
  'stop_agent',
  'read_output',
  'inspect_agent',
  'integrate_branch'
] as const

export type WorkerDownToolName = (typeof WORKER_DOWN_TOOL_NAMES)[number]

/** Long-poll defaults for `await_events`, kept under the 60 s MCP timeout. */
export const AWAIT_TIMEOUT_DEFAULT_SEC = 50
export const AWAIT_TIMEOUT_MAX_SEC = 55
export const READ_OUTPUT_DEFAULT_LINES = 60
export const READ_OUTPUT_MAX_LINES = 400
export const INSPECT_LOG_MAX_LINES = 50

/**
 * S1: above this many chars a tool result spills to a file (preview + path
 * instead of truncation). ~1.5k tokens — big enough that nothing routine
 * spills, small enough that a full diff or buffer never floods the context.
 */
export const SPILL_THRESHOLD_CHARS = 6_000
export const SPILL_HEAD_CHARS = 2_000
export const SPILL_TAIL_CHARS = 1_000

/** 41312 → "41_312" — the digit grouping the spill preview banner uses. */
function groupDigits(value: number): string {
  return String(value).replace(/\B(?=(\d{3})+$)/g, '_')
}

const SPILL_FAILED_NOTE = 'full output unavailable (spill failed)'

/**
 * C4: the latest `agent_done` reported on this branch, rendered as a handoff
 * block — or undefined when nothing was reported there (a plain repo branch,
 * or the done fell out of the event ring). Latest wins: after a rework round
 * the newer report describes the branch, the older one does not.
 */
export function handoffFor(events: EventQueue, baseBranch: string): string | undefined {
  const all = events.all()
  for (let index = all.length - 1; index >= 0; index -= 1) {
    const event = all[index]!
    if (event.type !== 'agent_done' || event.branch !== baseBranch) continue
    return buildHandoffBlock({
      agentName: event.name,
      role: event.roleId,
      branch: baseBranch,
      summary: event.summary,
      status: event.status,
      headSha: event.headSha,
      changedFiles: event.changedFiles,
      uncommitted: event.uncommitted
    })
  }
  return undefined
}

/**
 * One sentence, because it is repeated on EVERY empty long-poll — the most
 * frequent tool result of the whole run. It still has to carry the two rules
 * that keep the loop alive: call again with this cursor, never poll.
 */
const AWAIT_TIMEOUT_NOTE =
  'No events yet (normal — agents still working). Call await_events again with this cursor; never poll list_agents.'

function successionBlock(runtime: WorkspaceRuntime): ToolText | undefined {
  if (!runtime.ctx.host.successionInProgress()) return undefined
  return toolError({
    error: 'succession_in_progress',
    note:
      'An orchestrator succession is in progress. Wait for the successor. ' +
      'Do not start agents, send messages, stop agents, or record a retro.'
  })
}

/**
 * C5: every orchestrator tool call touches the runtime's idle watchdog — on
 * entry and on exit (see {@link WorkspaceRuntime.onOrchestratorToolCall}).
 * Wrapped at registration so no individual handler can forget it.
 */
function withOrchestratorTouch(
  server: McpServer,
  runtime: WorkspaceRuntime
): Pick<McpServer, 'registerTool'> {
  type LooseRegister = (name: string, config: unknown, handler: (...args: never[]) => unknown) => unknown
  const register = server.registerTool.bind(server) as unknown as LooseRegister
  return {
    registerTool: ((name: string, config: unknown, handler: (...args: unknown[]) => Promise<unknown>) =>
      register(name, config, (async (...args: unknown[]) => {
        runtime.onOrchestratorToolCall?.()
        try {
          return await handler(...args)
        } finally {
          runtime.onOrchestratorToolCall?.()
        }
      }) as unknown as (...args: never[]) => unknown)) as unknown as McpServer['registerTool']
  }
}

/**
 * Register the orchestration tools. Without `scope` this is the ROOT: all eleven
 * tools, reading the root queue, its direct children (leads included) in
 * view. With `scope` it is a LEAD (F) or a nested WORKER: the downward subset
 * only, its own queue, and every agent-addressing tool fenced to its own
 * subtree. A worker scope additionally drops the task board and the idle
 * watchdog (those belong to the root loop).
 */
export function registerOrchestratorTools(
  rawServer: McpServer,
  runtime: WorkspaceRuntime,
  scope?: { leadId: string; nest?: 'worker' }
): void {
  const { ctx } = runtime
  const server =
    scope?.nest === 'worker' ? rawServer : withOrchestratorTouch(rawServer, runtime)
  const leadId = scope?.leadId
  const workerNest = scope?.nest === 'worker'
  if (workerNest && leadId) ensureNest(runtime, leadId)

  // The long-poll window is resolved ONCE, at registration: the schema's `max`
  // and its description are baked into the tool definition the model sees, so
  // they must agree with the clamp the handler applies. A host that raised its
  // CLI's MCP request timeout says so via `ctx.awaitTimeout`; without it the
  // classic sub-60 s constants stand. Longer windows mean fewer empty wake-ups,
  // and every empty wake-up costs a full model pass over the whole context.
  const awaitDefault = ctx.awaitTimeout?.defaultSec ?? AWAIT_TIMEOUT_DEFAULT_SEC
  const awaitMax = ctx.awaitTimeout?.maxSec ?? AWAIT_TIMEOUT_MAX_SEC

  /**
   * C6: while a succession is pending, the ROOT's mutating tools refuse — the
   * predecessor must stop driving. Leads are agents of the run and keep
   * working through the handoff, so a scoped registration never gates.
   */
  const successionGate = (): ToolText | undefined =>
    leadId ? undefined : successionBlock(runtime)

  /** The caller's own event queue: the lead's, a worker nest, or the workspace root queue. */
  const ownQueue = (): EventQueue => {
    if (!leadId) return ctx.events
    if (workerNest) return ensureNest(runtime, leadId).events
    return runtime.leads.get(leadId)?.events ?? ctx.events
  }

  /**
   * E4: the wall-clock budget. Threshold events fire exactly once (80% and
   * exhaustion); once spent, new starts are refused — nothing else is.
   */
  const budgetGate = (): ToolText | undefined => {
    const budget = ctx.host.budget()
    if (budget.limitSec === undefined) return undefined
    const flags = (runtime.budgetFlags ??= { warned: false, exhausted: false })
    const push = (exhausted: boolean): void => {
      if (ctx.events.isClosed) return
      ctx.events.push({
        type: 'budget_warning',
        usedSec: budget.usedSec,
        limitSec: budget.limitSec!,
        exhausted
      })
    }
    if (!flags.warned && budget.usedSec >= budget.limitSec * 0.8) {
      flags.warned = true
      if (!budget.exhausted) push(false)
    }
    if (!budget.exhausted) return undefined
    if (!flags.exhausted) {
      flags.exhausted = true
      push(true)
    }
    return toolError({
      error: 'budget_exhausted',
      usedSec: budget.usedSec,
      limitSec: budget.limitSec,
      note: 'The workspace runtime budget is spent — no new agents. Verify what exists, stop your agents, and wrap up (record_retro, final summary).'
    })
  }

  /**
   * S1: oversized text spills to a file — the model gets head/tail plus the
   * absolute path to read or grep. A missing store keeps today's inline
   * behaviour, and a failed save degrades to a truncated inline text with a
   * note — never a tool error (fail-soft, like the journal).
   */
  const spillOversized = async (
    name: string,
    text: string
  ): Promise<
    | { kind: 'inline' }
    | { kind: 'spilled'; path: string; head: string; tail: string }
    | { kind: 'failed'; head: string; tail: string }
  > => {
    if (text.length <= SPILL_THRESHOLD_CHARS || !ctx.spill) return { kind: 'inline' }
    const head = text.slice(0, SPILL_HEAD_CHARS)
    const tail = text.slice(-SPILL_TAIL_CHARS)
    const path = await ctx.spill.save(name, text)
    return path ? { kind: 'spilled', path, head, tail } : { kind: 'failed', head, tail }
  }

  /** {@link spillOversized} for plain-text tool results (`read_output`). */
  const withSpill = async (name: string, text: string): Promise<ToolText> => {
    const outcome = await spillOversized(name, text)
    if (outcome.kind === 'inline') return toolText(text)
    if (outcome.kind === 'failed') {
      return toolText(`${outcome.head}\n…\n${outcome.tail}\nnote: ${SPILL_FAILED_NOTE}`)
    }
    return toolText(
      `[output too large: ${groupDigits(text.length)} chars — full text at\n` +
        ` ${outcome.path}\n` +
        ` read or grep that file for the full output]\n` +
        `${outcome.head}\n…\n${outcome.tail}`
    )
  }

  /** Fence: agent-addressing tools only reach the caller's DIRECT children. */
  const outOfScope = (agentId: string): ToolText | undefined => {
    if (inScope(runtime, agentId, leadId)) return undefined
    return toolError({
      error: 'unknown_agent',
      agentId,
      note: leadId
        ? 'That agent is not part of your subtree. You only address agents you started yourself; escalate to your orchestrator for anything else.'
        : 'That agent is not one of your direct children. A lead’s workers are addressed by their lead — send the lead an instruction instead.'
    })
  }

  /** S4: the honest refusal for runtimes without a board (old fakes). */
  const boardUnavailable = (): ToolText =>
    toolError({
      error: 'task_board_unavailable',
      note: 'This workspace has no task board. Track your plan in your own context instead.'
    })

  /** S4: board failures become tool errors verbatim — plus a note the model can act on. */
  const taskFailure = (failure: TaskBoardFailure): ToolText => {
    const body: Record<string, unknown> = { ...failure }
    delete body.ok
    const notes: Record<TaskBoardFailure['error'], string> = {
      stale_revision:
        'Your revision is outdated — the CURRENT task is in this payload. Reconcile against it and retry with task.revision.',
      unknown_task: 'No task with that id exists on the board. task_list shows what does.',
      task_deleted: 'That task is a tombstone — deleted is final. Create a new task instead.',
      dependency_cycle: 'These dependencies would close a cycle — restructure the blockedBy chain.',
      dependency_deleted: 'A dependency is deleted — drop it from blockedBy.',
      task_limit: 'The board is at its task limit. Deleted and completed tasks still count; plan coarser.',
      invalid_transition: 'That action does not apply to the task’s current status — see task_list.',
      missing_field: 'That action needs the named field.'
    }
    return toolError({ ...body, note: notes[failure.error] })
  }

  /**
   * S4 fence, same shape as the agent fence: a LEAD may hand tasks only to
   * itself or agents of its own subtree; the root assigns freely. delete and
   * reassign stay root-only (checked separately).
   */
  const ownerOutOfScope = (ownerAgentId: string): ToolText | undefined => {
    if (!leadId) return undefined
    if (ownerAgentId === leadId || inScope(runtime, ownerAgentId, leadId)) return undefined
    return toolError({
      error: 'owner_out_of_scope',
      ownerAgentId,
      note: 'A lead assigns tasks only to itself or to agents of its own subtree.'
    })
  }

  /** The compact row task_list returns — `ready` = pending ∧ deps completed. */
  const taskRow = (board: TaskBoard, task: Task) => ({
    taskId: task.taskId,
    revision: task.revision,
    subject: task.subject,
    status: task.status,
    ...(task.ownerAgentId ? { ownerAgentId: task.ownerAgentId } : {}),
    blockedBy: task.blockedBy,
    ready: board.isReady(task.taskId)
  })

  server.registerTool(
    'start_agent',
    {
      description:
        'Start a subagent for one self-contained task. The task text must state the goal, the files or ' +
        'area involved, the definition of done and how to verify it; Vertragus appends the reporting ' +
        'contract automatically. Every agent works in its own git worktree on its own branch, so agents ' +
        'never conflict with each other. Returns the agentId you address from then on. The agent starts ' +
        'in the background: await_events delivers agent_started once it accepted its task (or ' +
        'agent_start_failed) — do not send it messages before agent_started.',
      inputSchema: {
        role: z
          .string()
          .min(1)
          .describe(`One of the configured roles: ${ctx.roles.join(', ') || '(none configured)'}`),
        task: z.string().min(1).max(20_000).describe('The complete assignment for this agent'),
        model: z.string().min(1).max(200).optional().describe('Override the role default model'),
        providerId: z
          .string()
          .min(1)
          .max(200)
          .optional()
          .describe(
            'Pick the role slot running this provider (your system prompt lists each role’s ' +
              'slots). Without it the first slot with free capacity wins. A provider the role ' +
              'has no slot for is an error, never a silent fallback.'
          ),
        slotId: z
          .string()
          .min(1)
          .max(200)
          .optional()
          .describe(
            'Pick one specific profile slot by id. Unknown or full slots are an error — an ' +
              'explicit choice never lands elsewhere. Rarely needed; providerId is usually enough.'
          ),
        baseBranch: z
          .string()
          .min(1)
          .max(300)
          .optional()
          .describe(
            'Existing branch the new agent starts from — pass another agent’s branch so this ' +
              'agent builds on that result (e.g. a reviewer on a worker’s branch, or an agent ' +
              'merging teammates’ branches into its own). Default: the repository HEAD.'
          ),
        resultSchema: z
          .unknown()
          .optional()
          .describe(
            'Object-rooted JSON schema (small subset: type, properties, required, items, enum, ' +
              'const, additionalProperties) the agent’s final report_done result must match; keep ' +
              'it small. The agent retries until its result validates; the schema sticks for ' +
              'follow-up tasks via send_to_agent (one schema per agent life).'
          ),
        taskId: z
          .string()
          .regex(/^task-\d+$/)
          .optional()
          .describe(
            'S4: a pending board task this agent works on. The host claims it for the new ' +
              'agent (owner, in_progress) and appends its subject and description to the seed. ' +
              'A task that is unknown, deleted or not pending fails the start before anything runs.'
          )
      }
    },
    async ({
      role,
      task,
      model,
      baseBranch,
      slotId,
      providerId,
      resultSchema,
      taskId
    }): Promise<ToolText> => {
      const blocked = successionGate()
      if (blocked) return blocked
      if (!ctx.roles.includes(role)) {
        return toolError({
          error: 'unknown_role',
          role,
          availableRoles: ctx.roles,
          note: 'Use one of availableRoles exactly as written.'
        })
      }
      // S3: vet the result schema BEFORE anything is reserved — fail-loud like
      // slot errors. A schema that cannot be enforced (unsupported keywords,
      // non-object root, oversized) must never start an agent whose contract
      // then promises validation nobody performs.
      let vettedSchema: ResultSchema | undefined
      if (resultSchema !== undefined) {
        try {
          assertSupportedResultSchema(resultSchema)
        } catch (error) {
          return toolError({
            error: 'invalid_result_schema',
            problems: error instanceof ResultSchemaError ? error.problems : [errorMessage(error)],
            note: 'Fix the schema (or drop it) and call start_agent again — nothing was started.'
          })
        }
        const size = JSON.stringify(resultSchema).length
        if (size > RESULT_SCHEMA_MAX_CHARS) {
          return toolError({
            error: 'invalid_result_schema',
            problems: [
              `resultSchema: serialized schema is ${size} chars — the cap is ${RESULT_SCHEMA_MAX_CHARS}. Keep result schemas small.`
            ],
            note: 'Fix the schema (or drop it) and call start_agent again — nothing was started.'
          })
        }
        vettedSchema = resultSchema
      }
      const overBudget = budgetGate()
      if (overBudget) return overBudget
      if (workerNest && taskId) {
        return toolError({
          error: 'helpers_have_no_board',
          note: 'Helpers are not assigned from the shared task board. Put the assignment in task.'
        })
      }

      // Race-free without locks: `listAgents()` already counts reservations
      // (status `starting`), and nothing between this check and `beginAgent`
      // awaits — two concurrent start_agent calls therefore serialize through
      // this synchronous block and cannot both pass a cap of one.
      const running = runningAgents(ctx.host.listAgents())
      const perRoleMax = ctx.limits.perRole.get(role)
      const runningInRole = running.filter((agent) => agent.role === role).length
      if (perRoleMax !== undefined && runningInRole >= perRoleMax) {
        return toolError({
          error: 'limit_exceeded',
          scope: 'role',
          role,
          running: runningInRole,
          max: perRoleMax,
          note: `The role "${role}" is at its limit. Wait for one of its agents to finish and stop it, or use a different role.`
        })
      }
      if (ctx.limits.maxTotal !== undefined && running.length >= ctx.limits.maxTotal) {
        return toolError({
          error: 'limit_exceeded',
          scope: 'workspace',
          role,
          running: running.length,
          max: ctx.limits.maxTotal,
          note: 'The workspace is at its total agent limit. Stop an agent you no longer need before starting another.'
        })
      }
      // F: a lead also stays inside the subtree budget the root handed down.
      if (leadId) {
        const budget = workerNest
          ? MAX_HELPERS_PER_WORKER
          : runtime.leads.get(leadId)?.maxSubagents
        const mine = running.filter((agent) => inScope(runtime, agent.agentId, leadId)).length
        if (budget !== undefined && mine >= budget) {
          return toolError({
            error: 'limit_exceeded',
            scope: workerNest ? 'helpers' : 'subtree',
            role,
            running: mine,
            max: budget,
            note: workerNest
              ? 'You are at the helper cap. Stop one of your helpers first, or finish the slice yourself.'
              : 'Your subtree is at the budget your orchestrator gave you. Stop one of your agents first, or report the constraint upward.'
          })
        }
        if (workerNest && !canSpawnHelpers(runtime, leadId)) {
          return toolError({
            error: 'nest_depth',
            note: 'Helpers cannot start further helpers. Do the work yourself or ask your parent.'
          })
        }
      }

      // The contract is appended HERE, in the one place every subagent start
      // passes through, so no spawn path can produce an agent that never
      // reports back. The name is not allocated yet, hence role-only. Dialect
      // comes from the host (provider mcp.kind) — this layer does not guess.
      // C4: a baseBranch that carries reported work gets its handoff block
      // between task and contract, so the new agent starts from the
      // predecessor's own report instead of the orchestrator's prose.
      // S4: reservation of the board task, fail-loud BEFORE beginAgent. From
      // this check to the claim below nothing awaits, so the revision read
      // here cannot go stale in between (same race-free argument as the caps).
      let boardTask: Task | undefined
      if (taskId) {
        const board = runtime.taskBoard
        if (!board) return boardUnavailable()
        const found = board.get(taskId)
        if (!found) return taskFailure({ ok: false, error: 'unknown_task', taskId })
        if (found.status === 'deleted') return taskFailure({ ok: false, error: 'task_deleted', taskId })
        if (found.status !== 'pending') {
          return taskFailure({
            ok: false,
            error: 'invalid_transition',
            taskId,
            status: found.status,
            action: 'claim'
          })
        }
        boardTask = found
      }

      const reporting = ctx.host.reportingMode(role)
      // S3: a sentinel agent has no report_done call to validate — a schema
      // there would be a promise nobody keeps, so it is refused, not ignored.
      if (vettedSchema && reporting !== 'mcp') {
        return toolError({
          error: 'invalid_result_schema',
          problems: [
            `resultSchema: role "${role}" reports via PTY sentinel lines, not MCP — a structured result cannot be validated for it.`
          ],
          note: 'Drop resultSchema for this role and call start_agent again — nothing was started.'
        })
      }
      const handoff = baseBranch
        ? (handoffFor(ownQueue(), baseBranch) ??
          (ownQueue() === ctx.events ? undefined : handoffFor(ctx.events, baseBranch)))
        : undefined
      // D4: under `ask-orchestrator` the contract carries the approval rule —
      // the CLI still runs yolo (nobody watches a subagent terminal), so the
      // contract is where the gate lives.
      const contract = buildTaskContract({
        role,
        reporting,
        ...(ctx.agentPolicy === 'ask-orchestrator' ? { approvals: 'ask-orchestrator' as const } : {}),
        ...(vettedSchema ? { resultSchema: vettedSchema } : {}),
        // Root and leads start workers that MAY spawn helpers; a worker's
        // own start_agent starts a helper that cannot nest further. Unset
        // keeps the historical contract byte-identical for tests that omit it.
        ...(reporting === 'mcp' && !workerNest ? { helpers: true } : {})
      })
      // S4: the claimed task rides into the seed as host truth — subject and
      // description straight from the board, before the contract.
      const taskContext = boardTask
        ? `Task ${boardTask.taskId}: ${boardTask.subject}${
            boardTask.description ? `\n${boardTask.description}` : ''
          }`
        : undefined
      const seed = [
        task,
        ...(taskContext ? [taskContext] : []),
        ...(handoff ? [handoff] : []),
        contract
      ].join('\n\n')

      // `beginAgent` reserves synchronously and returns before the pipeline
      // (worktree, spawn, seed handshake) ran — that pipeline can outlast the
      // 60 s MCP request timeout, so this call must not sit on it. The outcome
      // arrives as an event instead.
      let started: StartingAgent
      try {
        started = ctx.host.beginAgent({ role, task: seed, model, baseBranch, slotId, providerId })
      } catch (error) {
        return toolError({ error: 'start_failed', role, message: errorMessage(error) })
      }
      // F: parented synchronously with the reservation — the child's events
      // route to this lead's queue from the very first one.
      if (leadId) runtime.parentOf.set(started.agentId, leadId)
      // S3: registered with the reservation, so a report_done racing the ready
      // handshake already validates. Removed again on start failure and stop.
      if (vettedSchema) runtime.resultSchemas.set(started.agentId, vettedSchema)
      // S4: claim in the same synchronous block as the check above — the
      // revision cannot have moved, so this cannot fail (guarded anyway).
      let claimWarning: string | undefined
      if (boardTask) {
        const claimed = runtime.taskBoard?.update(boardTask.taskId, boardTask.revision, 'claim', {
          ownerAgentId: started.agentId
        })
        if (claimed && !claimed.ok) {
          claimWarning = `Task ${boardTask.taskId} could not be claimed (${claimed.error}) — the agent starts anyway; fix the board with task_update.`
        }
      }
      recordAssignment(runtime, started.agentId, task)
      started.ready.then(
        () => {
          // Routed at resolution time: if the lead died mid-start the child
          // was adopted and the event belongs to the root now.
          const queue = queueForAgent(runtime, started.agentId)
          if (queue.isClosed) return
          queue.push(agentStartedEvent(started, runtime, task))
        },
        (error: unknown) => {
          // The workspace may have closed mid-start (stop button, quit) —
          // then there is no queue left and nobody to tell.
          runtime.parentOf.delete(started.agentId)
          runtime.resultSchemas.delete(started.agentId)
          const queue = leadId ? ownQueue() : ctx.events
          if (queue.isClosed) return
          queue.push({
            type: 'agent_start_failed',
            agentId: started.agentId,
            name: started.name,
            roleId: started.role,
            message: errorMessage(error)
          })
        }
      )
      return toolJson({
        agentId: started.agentId,
        name: started.name,
        role: started.role,
        providerId: started.providerId,
        model: started.model,
        worktreePath: started.worktreePath,
        branch: started.branch,
        ...(boardTask ? { taskId: boardTask.taskId } : {}),
        ...(claimWarning ? { warning: claimWarning } : {}),
        state: 'starting',
        // Short on purpose: the tool description already spells the rule out in
        // full, and this note is echoed back on every single start.
        note: 'Starting in the background — await_events brings agent_started or agent_start_failed. Do not message it before agent_started.'
      })
    }
  )

  server.registerTool(
    'send_to_agent',
    {
      description:
        'Talk to a running agent. Pass questionId to answer its open question (do this promptly — the ' +
        'agent is blocked until you do). Without questionId the text is typed into the agent as a new ' +
        'instruction or a follow-up task.',
      inputSchema: {
        agentId: z.string().min(1).describe('Agent to address, exactly as start_agent returned it'),
        text: z.string().min(1).max(20_000).describe('Your answer or the new instruction'),
        questionId: z
          .string()
          .min(1)
          .optional()
          .describe('The questionId from an agent_question event — answers that specific question')
      }
    },
    async ({ agentId, text, questionId }): Promise<ToolText> => {
      const blocked = successionGate()
      if (blocked) return blocked
      // F: one level only — answers and instructions go to DIRECT children.
      const fenced = outOfScope(agentId)
      if (fenced) return fenced
      if (questionId) {
        // One host path for answers — the panel badge and the remote gateway's
        // `answer_question` run through the same function (see answerQuestion.ts).
        const outcome = await answerAgentQuestion(runtime.questions, agentId, questionId, text)
        if (outcome.ok) return toolJson({ ok: true, delivered: 'answer', agentId, questionId })
        switch (outcome.error) {
          case 'unknown_question':
            return toolError({
              error: 'unknown_question',
              questionId,
              note: 'That question is already answered or no longer open. Call send_to_agent again without questionId to just send the text.'
            })
          case 'question_agent_mismatch':
            return toolError({
              error: 'question_agent_mismatch',
              questionId,
              expectedAgentId: outcome.expectedAgentId,
              note: 'Answer a question with the agentId that asked it.'
            })
          case 'answer_delivery_failed':
            return toolError({
              error: 'answer_delivery_failed',
              agentId,
              questionId,
              message: outcome.message,
              note: 'The question is still open — retry send_to_agent with the same questionId.'
            })
        }
      }

      const stillOpen = runtime.questions.openForAgent(agentId)
      const known = ctx.host.listAgents().find((agent) => agent.agentId === agentId)
      const reporting = known?.reporting ?? 'mcp'
      try {
        await ctx.host.sendToAgent(agentId, `${text}\n\n${buildReminderSuffix(reporting)}`)
      } catch (error) {
        return toolError({ error: 'send_failed', agentId, message: errorMessage(error) })
      }
      // A follow-up instruction is the agent's (and the workspace's) new
      // current task; a question answer (handled above) is not.
      recordAssignment(runtime, agentId, text)
      return toolJson({
        ok: true,
        delivered: 'message',
        agentId,
        ...(stillOpen
          ? {
              warning: 'This agent is still blocked on an open question.',
              openQuestionId: stillOpen.questionId,
              openQuestion: stillOpen.question
            }
          : {})
      })
    }
  )

  server.registerTool(
    'await_events',
    {
      description:
        'Block until your agents produce events, then return everything newer than your cursor. This is ' +
        'your main loop: call it, handle what comes back, call it again with the returned cursor. It is ' +
        'cheap and it is the only correct way to wait.',
      inputSchema: {
        cursor: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe('The cursor from your previous await_events call; 0 or omitted starts at the beginning'),
        timeoutSec: z
          .number()
          .int()
          .min(1)
          .max(awaitMax)
          .optional()
          .describe(`Seconds to block, default ${awaitDefault}, max ${awaitMax}`)
      }
    },
    async ({ cursor, timeoutSec }): Promise<ToolText> => {
      const from = cursor ?? 0
      const seconds = Math.min(timeoutSec ?? awaitDefault, awaitMax)
      // F: the root reads the root queue (direct children only — leads report
      // as one line each); a lead reads its own subtree queue.
      const queue = ownQueue()
      const events = await queue.wait(from, seconds * 1_000)
      const next = events.length > 0 ? events[events.length - 1]!.seq : from
      // A reader whose cursor fell behind the ring gets told, not left to
      // infer the loss from a seq jump nothing pointed at.
      const dropped = queue.droppedSince(from)
      // The empty result is the loop's most repeated answer, so it carries the
      // absolute minimum: nothing changed, so an agent overview would restate
      // what the orchestrator already knows. `list_agents` is one call away
      // when it actually wants one.
      if (events.length === 0 && !dropped) {
        return toolJson({ events, cursor: next, note: AWAIT_TIMEOUT_NOTE })
      }
      return toolJson({
        events,
        cursor: next,
        agentsSummary: slimAgentsSummary(runtime, { leadId }),
        ...(events.length === 0 ? { note: AWAIT_TIMEOUT_NOTE } : {}),
        ...(dropped
          ? {
              eventsDropped: dropped,
              note:
                `Events ${dropped.from}–${dropped.to} fell out of the buffer before this call — ` +
                'anything you derived from them may be stale. agentsSummary above is the current ' +
                'truth; reconcile against it instead of the missing events.'
            }
          : {})
      })
    }
  )

  server.registerTool(
    'list_agents',
    {
      description:
        'A snapshot of every agent in this workspace with its status, model, worktree, output age and ' +
        'open question. Use it for a one-off overview — never in a loop; await_events is how you wait.',
      inputSchema: {}
    },
    async (): Promise<ToolText> =>
      toolJson({ workspace: ctx.workspaceName, agents: summarizeAgents(runtime, { leadId }) })
  )

  server.registerTool(
    'stop_agent',
    {
      description:
        'End an agent and close its window. Its files, branches and worktrees stay. Stop agents you no ' +
        'longer need so their slot frees up.',
      inputSchema: { agentId: z.string().min(1) }
    },
    async ({ agentId }): Promise<ToolText> => {
      const blocked = successionGate()
      if (blocked) return blocked
      const fenced = outOfScope(agentId)
      if (fenced) return fenced
      const known = ctx.host.listAgents().find((agent) => agent.agentId === agentId)
      let stopped: boolean
      try {
        stopped = await ctx.host.stopAgent(agentId)
      } catch (error) {
        return toolError({ error: 'stop_failed', agentId, message: errorMessage(error) })
      }
      runtime.questions.cancelForAgent(agentId)
      // S3: a stopped agent reports nothing more — its result schema goes too.
      runtime.resultSchemas.delete(agentId)
      if (stopped && known) {
        const usage = await ctx.host.readTokenUsage?.(agentId).catch(() => undefined)
        // Into the parent's queue — for a stopped LEAD that is the root queue,
        // where the adoption tap reparents its children (F). Quiet: a pure
        // echo of the caller's own stop_agent — the tool result already said
        // everything; the event is for the journal and the panel.
        queueForAgent(runtime, agentId).push(
          {
            type: 'agent_stopped',
            agentId,
            name: known.name,
            roleId: known.role,
            ...(usage ? { tokenUsage: usage } : {})
          },
          { quiet: true }
        )
      }
      return toolJson({
        ok: stopped,
        agentId,
        ...(stopped ? {} : { note: 'No such running agent — it had already ended.' })
      })
    }
  )

  // Root-only surface: ask_user, record_retro and start_orchestrator never
  // exist on a lead session — depth 1 and "retro is the root's" are enforced
  // by absence, not by prompt discipline (F).
  if (!scope) {
  server.registerTool(
    'ask_user',
    {
      description:
        'Ask the HUMAN a question and wait for the answer — they see it in the panel, on the CLI overlay, and on their ' +
        'phone. When to call it is the question-mode block in your system prompt — that block is ' +
        'authoritative, not this schema. For a decision, pass 2–8 short labels in choices (at most 28); ' +
        'question is the prompt only — do not dump numbered options into it. Blocks until the user answers. If it returns answer: null, ' +
        'call it again with the returned ticket and the unchanged question (choices stay). Never continue without the answer.',
      inputSchema: {
        question: z
          .string()
          .min(1)
          .max(4_000)
          .describe('The prompt only — do not dump numbered options into this string'),
        choices: questionChoicesToolFieldSchema.describe(
          'Short labels for a decision (typically 2–8, at most 28, each ≤ 200 chars). The human taps one to answer. Omit for open-ended questions.'
        ),
        ticket: z
          .string()
          .min(1)
          .optional()
          .describe('Only when resuming: the ticket from a previous answer: null response')
      }
    },
    async ({ question, ticket, choices }): Promise<ToolText> => {
      // The same raised window that funds the long await_events poll: ask_user
      // runs on the orchestrator's own CLI, so awaitMax is exactly the block
      // this call can afford — a human who answers within it costs zero
      // `answer: null` round trips, and each of those is a full model turn.
      const timeoutMs = resolveAskTimeoutMs(
        ctx.askTimeoutMs,
        process.env,
        ctx.awaitTimeout ? ctx.awaitTimeout.maxSec * 1_000 : undefined
      )
      const userTicketNote =
        'The user has not answered yet. Call ask_user again with ticket set to the value above and ' +
        'the unchanged question. Do NOT rephrase and do NOT open a second question. While waiting ' +
        'you may keep handling agent events.'

      if (ticket) {
        // Ignore leftover/empty/invalid `choices` — they must not block resume.
        const resumed = await runtime.questions.waitForAnswer(
          ticket,
          USER_QUESTION_AGENT_ID,
          timeoutMs
        )
        if (resumed.state === 'answered') return toolJson({ answer: resumed.answer, ticket })
        if (resumed.state === 'timeout') return toolJson({ answer: null, ticket, note: userTicketNote })
        if (resumed.state === 'cancelled') {
          return toolJson({
            answer: null,
            ticket: null,
            note: 'The question was withdrawn (the workspace is stopping). Stop waiting.'
          })
        }
        return toolError({
          error: 'unknown_ticket',
          ticket,
          note: 'That ticket is not an open user question. Ask again without a ticket.'
        })
      }

      // One open user question at a time — a second one would give the human
      // two blocking prompts for one orchestrator.
      const alreadyOpen = runtime.questions.openForAgent(USER_QUESTION_AGENT_ID)
      const newChoices = alreadyOpen ? undefined : parseNewAskChoices(choices)
      const pending =
        alreadyOpen ??
        runtime.questions.create(USER_QUESTION_AGENT_ID, question, {
          ...(newChoices ? { choices: newChoices } : {})
        })
      if (!alreadyOpen) {
        // Quiet: the badge/remote signal for the PANEL — the asker itself is
        // blocked right here on waitForAnswer and must not be woken by the
        // echo of its own question.
        ctx.events.push(
          {
            type: 'user_question',
            questionId: pending.questionId,
            question,
            ...(pending.choices && pending.choices.length > 0 ? { choices: pending.choices } : {})
          },
          { quiet: true }
        )
      }

      const result = await runtime.questions.waitForAnswer(
        pending.questionId,
        USER_QUESTION_AGENT_ID,
        timeoutMs
      )
      if (result.state === 'answered') {
        return toolJson({ answer: result.answer, ticket: pending.questionId })
      }
      if (result.state === 'cancelled') {
        return toolJson({
          answer: null,
          ticket: null,
          note: 'The question was withdrawn (the workspace is stopping). Stop waiting.'
        })
      }
      return toolJson({ answer: null, ticket: pending.questionId, note: userTicketNote })
    }
  )

  server.registerTool(
    'record_retro',
    {
      description:
        'Your run retrospective — call it exactly once, at the end of the run, after stopping your ' +
        'agents. Never call it as part of a context handoff (that is request_succession). Give a ' +
        'one-or-two-sentence verdict and per-model learnings: for every model that ran, fill a ' +
        'strength AND a weakness slot when the run gave evidence for it. A slot may stay empty — ' +
        'never invent a weakness. These insights steer model choice in future runs.',
      inputSchema: {
        summary: z
          .string()
          .min(1)
          .max(500)
          .describe('One or two sentences: what the run achieved and how the team performed'),
        repoNotes: z
          .array(z.string().min(1).max(300))
          .max(10)
          .default([])
          .describe(
            'Durable facts about THIS repository worth telling the next run’s orchestrator ' +
              '("tests need pnpm run ci", "panel is a drag region"). Not run outcomes — those are the summary.'
          ),
        learnings: z
          .array(
            z.object({
              role: z
                .string()
                .min(1)
                .describe('Role the insight was observed in, exactly as start_agent took it'),
              model: z
                .string()
                .min(1)
                .max(200)
                .optional()
                .describe('Only when start_agent overrode the role default model'),
              kind: z.enum(['strength', 'weakness']),
              insight: z
                .string()
                .min(1)
                .max(200)
                .describe('One short, concrete, reusable observation about this model'),
              evidence: z
                .string()
                .max(300)
                .optional()
                .describe('What in this run supports the insight')
            })
          )
          .max(20)
          .default([])
      }
    },
    async ({ summary, learnings, repoNotes }): Promise<ToolText> => {
      const blocked = successionGate()
      if (blocked) return blocked
      const retro = ctx.retro
      if (!retro) {
        return toolError({
          error: 'retro_unavailable',
          note: 'This workspace records no retrospectives. Skip the retro and finish your summary to the user.'
        })
      }
      const unknownRoles = [...new Set(learnings.map((entry) => entry.role))].filter(
        (role) => !ctx.roles.includes(role)
      )
      if (unknownRoles.length > 0) {
        return toolError({
          error: 'unknown_role',
          unknownRoles,
          availableRoles: ctx.roles,
          note: 'Use the role ids exactly as start_agent took them, then call record_retro again.'
        })
      }
      retro.recordSummary(summary)
      const { applied } = retro.recordLearnings(learnings)
      const appliedNotes = repoNotes.length > 0 ? retro.recordRepoNotes?.(repoNotes)?.applied ?? 0 : 0
      // A3: the retro is the run's "work is done" — so it is where the
      // profile's auto-PR is opened and the orchestrator branch is
      // auto-promoted (PR first, so the branch is still ahead). Never able
      // to fail the retro: a pull request that could not be opened is a line
      // in the answer, not a lost retrospective.
      let pullRequest: RunPullRequest | undefined
      try {
        pullRequest = ctx.host.finishRunAutomation
          ? await ctx.host.finishRunAutomation({ summary })
          : await ctx.host.openRunPullRequest?.({ summary })
      } catch (error) {
        pullRequest = { ok: false, branch: '', base: '', message: errorMessage(error) }
      }
      return toolJson({
        ok: true,
        appliedLearnings: applied,
        appliedRepoNotes: appliedNotes,
        ...(pullRequest ? { pullRequest } : {}),
        note: pullRequest
          ? pullRequest.ok
            ? `Retro recorded and the pull request is open: ${pullRequest.url}. Name that link in your final summary to the user.`
            : `Retro recorded. No pull request was opened: ${pullRequest.message ?? 'unknown reason'}. Say so in your final summary — do not open one yourself.`
          : 'Retro recorded. Now give the user your final summary.'
      })
    }
  )

  server.registerTool(
    'start_orchestrator',
    {
      description:
        'Start a LEAD: a sub-orchestrator that owns one independent area with its own team and its ' +
        'own verification loop. Use it only when the goal has two or more independent workstreams ' +
        'that barely share files, or when a flat team would drown your await_events loop; stay flat ' +
        'otherwise. The lead runs your orchestrator provider, gets its own worktree and branch, and ' +
        'reports upward to you like a subagent (report_done / ask_orchestrator). Its team’s events ' +
        'go to the lead, not to you — await_events only shows you the lead itself. Leads cannot ' +
        'start leads (depth is exactly 1).',
      inputSchema: {
        area: z
          .string()
          .min(1)
          .max(200)
          .describe('Short label for the lead’s area, e.g. "payments" or "docs"'),
        task: z
          .string()
          .min(1)
          .max(20_000)
          .describe('The area’s complete goal: scope, definition of done, how to verify'),
        maxSubagents: z
          .number()
          .int()
          .min(1)
          .max(50)
          .optional()
          .describe(
            'Subtree budget you hand down — how many agents the lead may run at once. The global ' +
              'workspace cap still counts leads and their agents together.'
          ),
        model: z.string().min(1).max(200).optional().describe('Override the orchestrator model'),
        baseBranch: z
          .string()
          .min(1)
          .max(300)
          .optional()
          .describe('Existing branch the lead’s branch starts from. Default: the repository HEAD.')
      }
    },
    async ({ area, task, maxSubagents, model, baseBranch }): Promise<ToolText> => {
      const overBudget = budgetGate()
      if (overBudget) return overBudget
      if (runtime.leads.size >= MAX_LEADS) {
        return toolError({
          error: 'limit_exceeded',
          scope: 'leads',
          running: runtime.leads.size,
          max: MAX_LEADS,
          note: 'Lead cap reached. Finish or stop a lead before starting another — or stay flat.'
        })
      }
      // Global cap counts leads and grandchildren alike — one reservation net.
      const running = runningAgents(ctx.host.listAgents())
      if (ctx.limits.maxTotal !== undefined && running.length >= ctx.limits.maxTotal) {
        return toolError({
          error: 'limit_exceeded',
          scope: 'workspace',
          running: running.length,
          max: ctx.limits.maxTotal,
          note: 'The workspace is at its total agent limit (leads count). Stop something first.'
        })
      }

      const handoff = baseBranch ? handoffFor(ctx.events, baseBranch) : undefined
      const seed = [
        task,
        ...(handoff ? [handoff] : []),
        buildTaskContract({ role: 'lead', reporting: 'mcp' })
      ].join('\n\n')

      let started: StartingAgent
      try {
        started = ctx.host.beginLead({ area, task: seed, model, baseBranch, maxSubagents })
      } catch (error) {
        return toolError({ error: 'start_failed', area, message: errorMessage(error) })
      }
      // The lead's own queue exists from the reservation on — its children's
      // events have somewhere to go before the lead even finished booting.
      const lead: LeadRuntime = {
        agentId: started.agentId,
        area,
        events: new EventQueue(),
        ...(maxSubagents !== undefined ? { maxSubagents } : {})
      }
      runtime.leads.set(started.agentId, lead)
      attachSubtreeAdoptionTap(runtime, lead)
      runtime.onLeadCreated?.(lead)
      recordAssignment(runtime, started.agentId, task)
      started.ready.then(
        () => {
          if (ctx.events.isClosed) return
          ctx.events.push(agentStartedEvent(started, runtime, task))
        },
        (error: unknown) => {
          // The reservation is gone; so is the lead — adopt would-be children
          // (there are none yet) and close its queue.
          runtime.leads.delete(started.agentId)
          lead.events.close()
          if (ctx.events.isClosed) return
          ctx.events.push({
            type: 'agent_start_failed',
            agentId: started.agentId,
            name: started.name,
            roleId: started.role,
            message: errorMessage(error)
          })
        }
      )
      return toolJson({
        agentId: started.agentId,
        name: started.name,
        area,
        role: started.role,
        providerId: started.providerId,
        model: started.model,
        worktreePath: started.worktreePath,
        branch: started.branch,
        ...(maxSubagents !== undefined ? { maxSubagents } : {}),
        state: 'starting',
        note:
          'Lead reserved and starting in the background. await_events delivers agent_started once ' +
          'it accepted its area, or agent_start_failed. You will only see the lead’s own events ' +
          '(done / question / progress) — its team stays in its subtree.'
      })
    }
  )

  // S5: the pull side of the run memory. Root-only like record_retro — the
  // history is the ROOT's institutional memory, a lead gets its slice from
  // its task. The repo path comes from the workspace context; the CURRENT
  // run's journal lives on disk like every other, so it is searched for free.
  server.registerTool(
    'search_runs',
    {
      description:
        'Search this repository’s past run journals — use it before re-solving a problem an ' +
        'earlier run already hit (build quirks, flaky tests, decisions). Case-insensitive ' +
        'substring over every journaled event and each run’s goal (no regex); returns the newest ' +
        'matching runs with short excerpts.',
      inputSchema: {
        query: z
          .string()
          .min(3)
          .max(500)
          .describe('Plain substring to look for; whitespace in it matches any whitespace run'),
        maxResults: z
          .number()
          .int()
          .min(1)
          .max(20)
          .optional()
          .describe('Runs with matches to return, default 8')
      }
    },
    async ({ query, maxResults }): Promise<ToolText> => {
      try {
        const { hits, searchedRuns, skipped } = await searchRuns(ctx.repoPath, query, {
          maxResults
        })
        // The empty answer names its coverage — "no match" over zero searched
        // runs and over twenty are very different facts.
        const note =
          hits.length === 0
            ? `searched ${searchedRuns} runs, no match`
            : `${hits.length} matching runs of ${searchedRuns} searched, newest first`
        return toolJson({
          hits,
          searchedRuns,
          skipped,
          note: skipped.length > 0 ? `${note}; skipped oversized journals: ${skipped.join(', ')}` : note
        })
      } catch (error) {
        return toolError({ error: 'search_failed', message: errorMessage(error) })
      }
    }
  )
  } // end root-only surface

  server.registerTool(
    'read_output',
    {
      description:
        'The plain-text tail of an agent terminal. Use it after an agent_exited event with ' +
        'confirmed: false, and for debugging a stuck CLI. Do not use it to verify file changes — ' +
        'that is inspect_agent. full: true writes the complete buffer to a file and returns ' +
        'preview + path — read or grep that path instead of asking for more lines.',
      inputSchema: {
        agentId: z.string().min(1),
        lines: z
          .number()
          .int()
          .min(1)
          .max(READ_OUTPUT_MAX_LINES)
          .optional()
          .describe(`Lines from the end, default ${READ_OUTPUT_DEFAULT_LINES}, max ${READ_OUTPUT_MAX_LINES}`),
        full: z
          .boolean()
          .optional()
          .describe(
            'Read the WHOLE buffer instead of a tail: the full text is written to a file and ' +
              'this call returns a head/tail preview plus the absolute path'
          )
      }
    },
    async ({ agentId, lines, full }): Promise<ToolText> => {
      const fenced = outOfScope(agentId)
      if (fenced) return fenced
      try {
        // S1: the full read never inlines an unbounded buffer — it spills and
        // the model follows the returned path for anything past the preview.
        if (full) {
          const output = await ctx.host.readOutputFull(agentId)
          if (output.trim().length === 0) return toolText('(no output captured yet)')
          return await withSpill(`read-output-${agentId}`, output)
        }
        const count = Math.min(lines ?? READ_OUTPUT_DEFAULT_LINES, READ_OUTPUT_MAX_LINES)
        const output = await ctx.host.readOutput(agentId, count)
        return toolText(output.trim().length > 0 ? output : '(no output captured yet)')
      } catch (error) {
        return toolError({ error: 'read_failed', agentId, message: errorMessage(error) })
      }
    }
  )

  server.registerTool(
    'inspect_agent',
    {
      description:
        'Read-only git facts from an agent’s own worktree: status, diff, log, or one file. This is ' +
        'how you verify what the agent actually changed — never by running git yourself and never ' +
        'by treating read_output as a diff. Stopped agents remain inspectable. Agents that are ' +
        'still starting are not.',
      inputSchema: {
        agentId: z.string().min(1).describe('Agent to inspect, exactly as start_agent returned it'),
        view: z
          .enum(INSPECT_VIEWS)
          .describe('status = porcelain + diffstat, diff = git diff HEAD plus untracked names, log = oneline, file = one utf-8 file'),
        path: z
          .string()
          .min(1)
          .max(500)
          .optional()
          .describe(
            'Relative path inside the agent worktree — required for view "file", and optional for ' +
              'view "diff" to restrict the diff to that file or directory'
          ),
        lines: z
          .number()
          .int()
          .min(1)
          .max(INSPECT_LOG_MAX_LINES)
          .optional()
          .describe(`Commit count for view "log", default 20, max ${INSPECT_LOG_MAX_LINES}`)
      }
    },
    async ({ agentId, view, path, lines }): Promise<ToolText> => {
      const fenced = outOfScope(agentId)
      if (fenced) return fenced
      try {
        const result = await ctx.host.inspectAgent(agentId, { view, path, lines })
        // S1: only diff and file can grow without bound — status and log are
        // small by construction and keep their exact shape. An oversized body
        // spills; the compact result keeps the toolJson format via spillPath.
        if (view === 'diff' || view === 'file') {
          const outcome = await spillOversized(`inspect-${view}-${agentId}`, result.body)
          if (outcome.kind === 'spilled') {
            return toolJson({
              agentId,
              view,
              truncated: true,
              spillPath: outcome.path,
              head: outcome.head,
              tail: outcome.tail
            })
          }
          if (outcome.kind === 'failed') {
            return toolJson({
              agentId,
              view,
              truncated: true,
              head: outcome.head,
              tail: outcome.tail,
              note: SPILL_FAILED_NOTE
            })
          }
        }
        return toolJson({ agentId, ...result })
      } catch (error) {
        return toolError({ error: 'inspect_failed', agentId, message: errorMessage(error) })
      }
    }
  )

  server.registerTool(
    'integrate_branch',
    {
      description:
        'HOST-side merge (E1): merge another agent’s branch into the TARGET agent’s worktree. You ' +
        'never merge yourself — this is the one sanctioned path. On conflict the merge is aborted ' +
        '(the worktree stays clean) and the conflicting files are reported; then task an agent with ' +
        'resolving, or restructure the work. The result also warns when the source branch’s last ' +
        'report was not a verified success — integrating unreviewed work is how gates become theater.',
      inputSchema: {
        agentId: z
          .string()
          .min(1)
          .describe('TARGET agent whose worktree receives the merge (often your integrator agent)'),
        branch: z
          .string()
          .min(1)
          .max(300)
          .describe('Source branch to merge in — another agent’s vertragus/* branch')
      }
    },
    async ({ agentId, branch }): Promise<ToolText> => {
      const fenced = outOfScope(agentId)
      if (fenced) return fenced
      const known = ctx.host.listAgents().find((agent) => agent.agentId === agentId)
      const identityFields = {
        agentId,
        name: known?.name ?? agentId,
        roleId: known?.role ?? 'unknown'
      }
      // E1 gate (soft): warn when the branch's latest report is not a clean success.
      const lastDone = [...ctx.events.all(), ...(leadId ? ownQueue().all() : [])]
        .reverse()
        .find((event) => event.type === 'agent_done' && event.branch === branch)
      const gateWarning =
        lastDone && lastDone.type === 'agent_done'
          ? lastDone.status !== 'success'
            ? `The last report on ${branch} was "${lastDone.status}" — integrating unverified work.`
            : lastDone.uncommitted
              ? `The last report on ${branch} left uncommitted changes behind.`
              : undefined
          : `No agent_done was reported on ${branch} — integrating work nobody verified.`

      let outcome
      try {
        outcome = await ctx.host.integrateBranch(agentId, branch)
      } catch (error) {
        return toolError({ error: 'integrate_failed', agentId, branch, message: errorMessage(error) })
      }
      const queue = queueForAgent(runtime, agentId)
      // Both integrate events are quiet: the tool result below carries the
      // same data synchronously — the events exist for journal/panel/retro,
      // not to wake the caller with an echo of its own merge.
      if (outcome.ok) {
        if (!queue.isClosed) {
          queue.push(
            { type: 'integrate_ok', ...identityFields, branch, headSha: outcome.headSha },
            { quiet: true }
          )
        }
        return toolJson({
          ok: true,
          agentId,
          branch,
          headSha: outcome.headSha,
          ...(gateWarning ? { warning: gateWarning } : {})
        })
      }
      if (!queue.isClosed) {
        queue.push(
          {
            type: 'integrate_conflict',
            ...identityFields,
            branch,
            conflictFiles: outcome.conflictFiles,
            message: outcome.message.slice(0, 2_000)
          },
          { quiet: true }
        )
      }
      return toolError({
        error: 'integrate_conflict',
        agentId,
        branch,
        conflictFiles: outcome.conflictFiles,
        message: outcome.message.slice(0, 2_000),
        note: 'The merge was aborted — the worktree is clean. Task an agent with resolving the conflict (give it both branches), or restructure the work.',
        ...(gateWarning ? { warning: gateWarning } : {})
      })
    }
  )

  // S4: the task board — the shared plan of root and leads, host state that
  // survives succession and resume. Three tools, no task_get (task_list is
  // small enough). delete/reassign are root-only; owners are fenced like
  // agents (a lead assigns only into its own subtree). Workers that nest
  // coordinate helpers through start_agent / await_events, not the board.
  if (!workerNest) {
  server.registerTool(
    'task_create',
    {
      description:
        'Create a task on the shared task board — your plan as host state: it survives orchestrator ' +
        'succession and resume, unlike your own context. One task per unit of work you will hand to ' +
        'an agent. blockedBy lists taskIds that must be completed first (acyclic). Returns the taskId ' +
        'and its revision — pass that revision to task_update (it moves on every change).',
      inputSchema: {
        subject: z.string().min(1).max(200).describe('One line: what this task delivers'),
        description: z
          .string()
          .max(2_000)
          .optional()
          .describe('The full assignment — start_agent{taskId} seeds it to the claiming agent'),
        blockedBy: z
          .array(z.string().regex(/^task-\d+$/))
          .max(20)
          .optional()
          .describe('taskIds that must be completed before this one is ready'),
        ownerAgentId: z
          .string()
          .min(1)
          .optional()
          .describe('Assign immediately to a running agent (the task starts in_progress)')
      }
    },
    async ({ subject, description, blockedBy, ownerAgentId }): Promise<ToolText> => {
      const blocked = successionGate()
      if (blocked) return blocked
      const board = runtime.taskBoard
      if (!board) return boardUnavailable()
      if (ownerAgentId) {
        const fenced = ownerOutOfScope(ownerAgentId)
        if (fenced) return fenced
      }
      const created = board.create({ subject, description, blockedBy, ownerAgentId })
      if (!created.ok) return taskFailure(created)
      // The board is on the workspace card now, and a board mutation pushes no
      // agent event — the assignment feed is what wakes the panel. Same hook as
      // recordAssignment on purpose: one change channel, not a second one.
      runtime.onTasksChanged?.()
      return toolJson({ taskId: created.task.taskId, revision: created.task.revision })
    }
  )

  server.registerTool(
    'task_update',
    {
      description:
        'Mutate one board task with compare-and-swap: pass the revision you last saw; if the task ' +
        'changed since, you get stale_revision WITH the current task — reconcile and retry. Actions: ' +
        'claim (owner + in_progress; needs ownerAgentId), release (back to pending, owner-free), edit ' +
        '(subject/description), set_dependencies (blockedBy, acyclic), complete (ONLY after you ' +
        'verified the work — never on the agent’s word alone), reopen (completed back to pending), ' +
        'delete (tombstone, root-only), reassign (new owner, root-only). Returns the new task snapshot.',
      inputSchema: {
        taskId: z.string().regex(/^task-\d+$/),
        expectedRevision: z
          .number()
          .int()
          .positive()
          .describe('The revision you last saw for this task'),
        action: z.enum(TASK_ACTIONS),
        subject: z.string().min(1).max(200).optional().describe('For action "edit"'),
        description: z.string().max(2_000).optional().describe('For action "edit"'),
        blockedBy: z
          .array(z.string().regex(/^task-\d+$/))
          .max(20)
          .optional()
          .describe('For action "set_dependencies" — the complete new list'),
        ownerAgentId: z
          .string()
          .min(1)
          .optional()
          .describe('For actions "claim" and "reassign"')
      }
    },
    async ({ taskId, expectedRevision, action, subject, description, blockedBy, ownerAgentId }): Promise<ToolText> => {
      const blocked = successionGate()
      if (blocked) return blocked
      const board = runtime.taskBoard
      if (!board) return boardUnavailable()
      // The dsh authorization matrix, one step simpler: destructive and
      // cross-team actions belong to the root alone.
      if (leadId && (action === 'delete' || action === 'reassign')) {
        return toolError({
          error: 'root_only_action',
          action,
          note: 'delete and reassign are the root orchestrator’s — report the need upward instead.'
        })
      }
      if (ownerAgentId && (action === 'claim' || action === 'reassign')) {
        const fenced = ownerOutOfScope(ownerAgentId)
        if (fenced) return fenced
      }
      const updated = board.update(taskId, expectedRevision, action, {
        subject,
        description,
        blockedBy,
        ownerAgentId
      })
      if (!updated.ok) return taskFailure(updated)
      runtime.onTasksChanged?.()
      return toolJson({ task: updated.task, ready: board.isReady(taskId) })
    }
  )

  server.registerTool(
    'task_list',
    {
      description:
        'The shared task board — your plan as compact rows; it survives succession and resume. ' +
        'ready: true means pending with every blockedBy completed (deleted dependencies are ignored). ' +
        'Filter by status to see only pending, in_progress, completed or deleted tasks.',
      inputSchema: {
        status: z.enum(TASK_STATUSES).optional().describe('Only tasks with this status')
      }
    },
    async ({ status }): Promise<ToolText> => {
      const board = runtime.taskBoard
      if (!board) return boardUnavailable()
      const tasks = board.list(status ? { status } : undefined)
      return toolJson({ tasks: tasks.map((task) => taskRow(board, task)) })
    }
  )
  }

  // C6 root-only: a lead never replaces the root orchestrator, and depth
  // stays 1 — succession is serial replacement of the ROOT, nothing else.
  if (!scope) {
    server.registerTool(
      'request_succession',
      {
        description:
          'Replace yourself with a successor orchestrator that continues this run with a fresh context. ' +
          'Call this when your context is nearly full, the provider warns about context, or you are ' +
          'losing track of agents or decisions. Do not call it when the goal is done — that is ' +
          'record_retro. Fill goal, decisions, risks and nextActions honestly; omit unknowns. After ' +
          'this returns, stop: the successor takes the loop. This is serial replacement, not a second ' +
          'concurrent orchestrator.',
        inputSchema: {
          reason: successionRequestSchema.shape.reason.describe(
            'Why you are handing off. context_full is the usual case.'
          ),
          goal: successionRequestSchema.shape.goal,
          decisions: successionRequestSchema.shape.decisions,
          risks: successionRequestSchema.shape.risks,
          nextActions: successionRequestSchema.shape.nextActions,
          agentNotes: successionRequestSchema.shape.agentNotes,
          note: successionRequestSchema.shape.note
        }
      },
      async (args): Promise<ToolText> => {
        let parsed
        try {
          parsed = successionRequestSchema.parse(args)
        } catch (error) {
          return toolError({ error: 'invalid_package', message: errorMessage(error) })
        }
        try {
          const started = ctx.host.requestSuccession(parsed)
          return toolJson({
            successorAgentId: started.successorAgentId,
            successorName: started.successorName,
            predecessorAgentId: started.predecessorAgentId,
            eventCursor: started.eventCursor,
            state: 'succession_started',
            note:
              'Successor is starting in the background. Stop now. await_events is no longer yours — ' +
              `the successor will resume from cursor ${started.eventCursor}.`
          })
        } catch (error) {
          const message = errorMessage(error)
          const code = message.includes('already_in_progress')
            ? 'already_in_progress'
            : message.includes('no_orchestrator')
              ? 'no_orchestrator'
              : 'succession_failed'
          return toolError({ error: code, message })
        }
      }
    )
  }
}
