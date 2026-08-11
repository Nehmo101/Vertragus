/**
 * The three tools a subagent gets. Its identity is fixed server-side from the
 * URL — a worker can neither claim to be another agent nor reach an
 * orchestrator tool, because it never gets a schema for one.
 *
 * `ask_orchestrator` is the important one: it blocks server-side for ~50 s
 * (under the 60 s MCP request timeout) and, on timeout, hands out a ticket that
 * resumes the SAME question. The old repo instead let a worker re-ask, produced
 * three questions nobody answered, and starved the worker.
 */
import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { AGENT_DONE_STATUSES } from '@shared/schema/events'
import { errorMessage, toolError, toolJson, type ToolText, type WorkspaceRuntime } from './types'

export const SUBAGENT_TOOL_NAMES = ['report_done', 'ask_orchestrator', 'report_progress'] as const
export type SubagentToolName = (typeof SUBAGENT_TOOL_NAMES)[number]

/** Server-side block for `ask_orchestrator`, below the 60 s MCP request timeout. */
export const ASK_TIMEOUT_DEFAULT_MS = 50_000
export const PROGRESS_NOTE_MAX = 500

/**
 * Resolve the ask window: workspace option first, then the
 * `VERTRAGUS_ASK_TIMEOUT_MS` environment override (used by the integration
 * harness to force the ticket path in milliseconds instead of a minute), then
 * the 50 s default.
 */
export function resolveAskTimeoutMs(
  configured: number | undefined,
  env: NodeJS.ProcessEnv = process.env
): number {
  if (configured !== undefined && Number.isFinite(configured) && configured > 0) return configured
  const raw = Number(env.VERTRAGUS_ASK_TIMEOUT_MS)
  if (Number.isFinite(raw) && raw > 0) return raw
  return ASK_TIMEOUT_DEFAULT_MS
}

const TICKET_NOTE =
  'The orchestrator has not answered yet. Call ask_orchestrator again with ticket set to the value ' +
  'above. Do NOT rephrase the question and do NOT open a new one — the ticket resumes the same ' +
  'question. Keep waiting; do not guess and do not continue without the answer.'

export function registerSubagentTools(
  server: McpServer,
  runtime: WorkspaceRuntime,
  agentId: string
): void {
  const { ctx } = runtime

  /** Identity for the event stream; falls back to the id if the host lost the row. */
  function identity(): { agentId: string; name: string; roleId: string } {
    const known = ctx.host.listAgents().find((agent) => agent.agentId === agentId)
    return { agentId, name: known?.name ?? agentId, roleId: known?.role ?? 'unknown' }
  }

  server.registerTool(
    'report_done',
    {
      description:
        'Report that your current task is finished. Say what you changed and how you verified it. You ' +
        'may call this again for every follow-up task you receive.',
      inputSchema: {
        summary: z
          .string()
          .min(1)
          .max(4_000)
          .describe('What you changed and how you verified it — facts, not intentions'),
        status: z
          .enum(AGENT_DONE_STATUSES)
          .optional()
          .describe(
            'success = done and verified (default), blocked = something outside your control stops you, failed = you tried and it does not work'
          )
      }
    },
    async ({ summary, status }): Promise<ToolText> => {
      ctx.events.push({ type: 'agent_done', ...identity(), summary, status: status ?? 'success' })
      return toolJson({
        ok: true,
        note: 'The orchestrator has your result. Stay available: it either sends you a follow-up task or stops you. Do not exit on your own.'
      })
    }
  )

  server.registerTool(
    'ask_orchestrator',
    {
      description:
        'Ask the orchestrator a concrete question and wait for the answer. This call blocks until the ' +
        'answer arrives. If it returns answer: null, call it again with the returned ticket and the ' +
        'unchanged question. Never guess an answer and never continue without one.',
      inputSchema: {
        question: z
          .string()
          .min(1)
          .max(4_000)
          .describe('One concrete question, with the context needed to answer it'),
        ticket: z
          .string()
          .min(1)
          .optional()
          .describe('Only when resuming: the ticket from a previous answer: null response')
      }
    },
    async ({ question, ticket }): Promise<ToolText> => {
      const timeoutMs = resolveAskTimeoutMs(ctx.askTimeoutMs)

      if (ticket) {
        const resumed = await runtime.questions.waitForAnswer(ticket, agentId, timeoutMs)
        if (resumed.state === 'answered') return toolJson({ answer: resumed.answer, ticket })
        if (resumed.state === 'timeout') return toolJson({ answer: null, ticket, note: TICKET_NOTE })
        if (resumed.state === 'cancelled') {
          return toolJson({
            answer: null,
            ticket: null,
            note: 'The question was withdrawn (you are being stopped or reassigned). Stop waiting.'
          })
        }
        return toolError({
          error: 'unknown_ticket',
          ticket,
          note: 'That ticket is not open for you. Ask again without a ticket to open a fresh question.'
        })
      }

      // A second open question would give the orchestrator two things to answer
      // for one blocked agent; reuse the open one instead.
      const alreadyOpen = runtime.questions.openForAgent(agentId)
      const pending = alreadyOpen ?? runtime.questions.create(agentId, question)
      if (!alreadyOpen) {
        ctx.events.push({
          type: 'agent_question',
          ...identity(),
          questionId: pending.questionId,
          question
        })
      }

      const result = await runtime.questions.waitForAnswer(pending.questionId, agentId, timeoutMs)
      if (result.state === 'answered') return toolJson({ answer: result.answer, ticket: pending.questionId })
      if (result.state === 'cancelled') {
        return toolJson({
          answer: null,
          ticket: null,
          note: 'The question was withdrawn (you are being stopped or reassigned). Stop waiting.'
        })
      }
      return toolJson({ answer: null, ticket: pending.questionId, note: TICKET_NOTE })
    }
  )

  server.registerTool(
    'report_progress',
    {
      description:
        'Report a real milestone in one line (not a heartbeat). The orchestrator sees it live; it does ' +
        'not reply to it.',
      inputSchema: {
        note: z.string().min(1).max(PROGRESS_NOTE_MAX).describe('What you just achieved, one line')
      }
    },
    async ({ note }): Promise<ToolText> => {
      try {
        ctx.events.push({ type: 'agent_progress', ...identity(), note })
      } catch (error) {
        return toolError({ error: 'progress_failed', message: errorMessage(error) })
      }
      return toolJson({ ok: true })
    }
  )
}
