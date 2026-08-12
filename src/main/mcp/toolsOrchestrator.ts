/**
 * The six tools the orchestrator agent gets. Everything the orchestrator can
 * do to the world goes through here — there is no second path.
 *
 * The tools deliberately do very little themselves: check the limits, compose
 * the contract, translate host results into JSON, and push the lifecycle events
 * the orchestrator later reads back through `await_events`.
 */
import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { buildReminderSuffix, buildTaskContract } from '@shared/prompts/contract'
import {
  errorMessage,
  runningAgents,
  summarizeAgents,
  taskNote,
  toolError,
  toolJson,
  toolText,
  type ToolText,
  type WorkspaceRuntime
} from './types'

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
  'read_output'
] as const

export type OrchestratorToolName = (typeof ORCHESTRATOR_TOOL_NAMES)[number]

/** Long-poll defaults for `await_events`, kept under the 60 s MCP timeout. */
export const AWAIT_TIMEOUT_DEFAULT_SEC = 50
export const AWAIT_TIMEOUT_MAX_SEC = 55
export const READ_OUTPUT_DEFAULT_LINES = 60
export const READ_OUTPUT_MAX_LINES = 400

const AWAIT_TIMEOUT_NOTE =
  'No events within the wait window — this is normal, the agents are still working. ' +
  'Call await_events again with the cursor from this response. Do not stop, do not idle, ' +
  'and do not switch to polling list_agents.'

export function registerOrchestratorTools(server: McpServer, runtime: WorkspaceRuntime): void {
  const { ctx } = runtime

  server.registerTool(
    'start_agent',
    {
      description:
        'Start a subagent for one self-contained task. The task text must state the goal, the files or ' +
        'area involved, the definition of done and how to verify it; Vertragus appends the reporting ' +
        'contract automatically. Every agent works in its own git worktree on its own branch, so agents ' +
        'never conflict with each other. Returns the agentId you address from then on.',
      inputSchema: {
        role: z
          .string()
          .min(1)
          .describe(`One of the configured roles: ${ctx.roles.join(', ') || '(none configured)'}`),
        task: z.string().min(1).max(20_000).describe('The complete assignment for this agent'),
        model: z.string().min(1).max(200).optional().describe('Override the role default model'),
        baseBranch: z
          .string()
          .min(1)
          .max(300)
          .optional()
          .describe(
            'Existing branch the new agent starts from — pass another agent’s branch so this ' +
              'agent builds on that result (e.g. a reviewer on a worker’s branch, or an agent ' +
              'merging teammates’ branches into its own). Default: the repository HEAD.'
          )
      }
    },
    async ({ role, task, model, baseBranch }): Promise<ToolText> => {
      if (!ctx.roles.includes(role)) {
        return toolError({
          error: 'unknown_role',
          role,
          availableRoles: ctx.roles,
          note: 'Use one of availableRoles exactly as written.'
        })
      }

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

      // The contract is appended HERE, in the one place every subagent start
      // passes through, so no spawn path can produce an agent that never
      // reports back. The name is not allocated yet, hence role-only. Dialect
      // comes from the host (provider mcp.kind) — this layer does not guess.
      const reporting = ctx.host.reportingMode(role)
      const seed = `${task}\n\n${buildTaskContract({ role, reporting })}`

      try {
        const started = await ctx.host.startAgent({ role, task: seed, model, baseBranch })
        runtime.latestTask = taskNote(task) ?? runtime.latestTask
        ctx.events.push({
          type: 'agent_started',
          agentId: started.agentId,
          name: started.name,
          roleId: started.role,
          model,
          worktreePath: started.worktreePath,
          branch: started.branch
        })
        return toolJson({
          agentId: started.agentId,
          name: started.name,
          role: started.role,
          worktreePath: started.worktreePath,
          branch: started.branch,
          note: 'Agent started. Wait for its events with await_events instead of asking it for status.'
        })
      } catch (error) {
        return toolError({ error: 'start_failed', role, message: errorMessage(error) })
      }
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
      if (questionId) {
        const open = runtime.questions.get(questionId)
        if (!open) {
          return toolError({
            error: 'unknown_question',
            questionId,
            note: 'That question is already answered or no longer open. Call send_to_agent again without questionId to just send the text.'
          })
        }
        if (open.agentId !== agentId) {
          return toolError({
            error: 'question_agent_mismatch',
            questionId,
            expectedAgentId: open.agentId,
            note: 'Answer a question with the agentId that asked it.'
          })
        }
        // Sentinel questions: deliver to the PTY FIRST, then close the registry.
        // Closing first left a failed seed with no open question and a stuck
        // agent (dedup still held the ASK hash). MCP questions have no
        // deliverAnswer — answer() alone wakes waitForAnswer as before.
        if (open.deliverAnswer) {
          try {
            await open.deliverAnswer(text)
          } catch (error) {
            return toolError({
              error: 'answer_delivery_failed',
              agentId,
              questionId,
              message: errorMessage(error),
              note: 'The question is still open — retry send_to_agent with the same questionId.'
            })
          }
          runtime.questions.answer(questionId, text)
          return toolJson({ ok: true, delivered: 'answer', agentId, questionId })
        }
        runtime.questions.answer(questionId, text)
        return toolJson({ ok: true, delivered: 'answer', agentId, questionId })
      }

      const stillOpen = runtime.questions.openForAgent(agentId)
      const known = ctx.host.listAgents().find((agent) => agent.agentId === agentId)
      const reporting = known?.reporting ?? 'mcp'
      try {
        await ctx.host.sendToAgent(agentId, `${text}\n\n${buildReminderSuffix(reporting)}`)
      } catch (error) {
        return toolError({ error: 'send_failed', agentId, message: errorMessage(error) })
      }
      // A follow-up instruction is the workspace's new current task; a question
      // answer (handled above) is not.
      runtime.latestTask = taskNote(text) ?? runtime.latestTask
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
          .max(AWAIT_TIMEOUT_MAX_SEC)
          .optional()
          .describe(`Seconds to block, default ${AWAIT_TIMEOUT_DEFAULT_SEC}, max ${AWAIT_TIMEOUT_MAX_SEC}`)
      }
    },
    async ({ cursor, timeoutSec }): Promise<ToolText> => {
      const from = cursor ?? 0
      const seconds = Math.min(timeoutSec ?? AWAIT_TIMEOUT_DEFAULT_SEC, AWAIT_TIMEOUT_MAX_SEC)
      const events = await ctx.events.wait(from, seconds * 1_000)
      const next = events.length > 0 ? events[events.length - 1]!.seq : from
      return toolJson({
        events,
        cursor: next,
        agentsSummary: summarizeAgents(runtime),
        ...(events.length === 0 ? { note: AWAIT_TIMEOUT_NOTE } : {})
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
      toolJson({ workspace: ctx.workspaceName, agents: summarizeAgents(runtime) })
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
      const known = ctx.host.listAgents().find((agent) => agent.agentId === agentId)
      let stopped: boolean
      try {
        stopped = await ctx.host.stopAgent(agentId)
      } catch (error) {
        return toolError({ error: 'stop_failed', agentId, message: errorMessage(error) })
      }
      runtime.questions.cancelForAgent(agentId)
      if (stopped && known) {
        ctx.events.push({
          type: 'agent_stopped',
          agentId,
          name: known.name,
          roleId: known.role
        })
      }
      return toolJson({
        ok: stopped,
        agentId,
        ...(stopped ? {} : { note: 'No such running agent — it had already ended.' })
      })
    }
  )

  server.registerTool(
    'read_output',
    {
      description:
        'The plain-text tail of an agent terminal. Use it to verify what an agent actually did, and ' +
        'always after an agent_exited event with confirmed: false.',
      inputSchema: {
        agentId: z.string().min(1),
        lines: z
          .number()
          .int()
          .min(1)
          .max(READ_OUTPUT_MAX_LINES)
          .optional()
          .describe(`Lines from the end, default ${READ_OUTPUT_DEFAULT_LINES}, max ${READ_OUTPUT_MAX_LINES}`)
      }
    },
    async ({ agentId, lines }): Promise<ToolText> => {
      const count = Math.min(lines ?? READ_OUTPUT_DEFAULT_LINES, READ_OUTPUT_MAX_LINES)
      try {
        const output = await ctx.host.readOutput(agentId, count)
        return toolText(output.trim().length > 0 ? output : '(no output captured yet)')
      } catch (error) {
        return toolError({ error: 'read_failed', agentId, message: errorMessage(error) })
      }
    }
  )
}
