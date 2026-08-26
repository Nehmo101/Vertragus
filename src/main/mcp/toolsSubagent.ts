/**
 * The three tools a subagent gets. Its identity is fixed server-side from the
 * URL — a worker can neither claim to be another agent nor reach an
 * orchestrator tool, because it never gets a schema for one.
 *
 * `ask_orchestrator` is the important one: it blocks server-side — ~50 s under
 * the CLIs' 60 s MCP request timeout, or the agent's own raised window when its
 * provider declares `mcpToolTimeoutSec` — and, on timeout, hands out a ticket
 * that resumes the SAME question. The old repo instead let a worker re-ask,
 * produced three questions nobody answered, and starved the worker.
 */
import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { parseNewAskChoices, questionChoicesToolFieldSchema } from '@shared/questionChoices'
import { AGENT_DONE_STATUSES, type JsonValue } from '@shared/schema/events'
import { RESULT_MAX_CHARS, validateResult } from '@shared/schema/resultSchema'
import {
  errorMessage,
  queueForAgent,
  toolError,
  toolJson,
  worktreeEventFields,
  type ToolText,
  type WorkspaceRuntime
} from './types'

export const SUBAGENT_TOOL_NAMES = ['report_done', 'ask_orchestrator', 'report_progress'] as const
export type SubagentToolName = (typeof SUBAGENT_TOOL_NAMES)[number]

/** Server-side block for `ask_orchestrator`, below the 60 s MCP request timeout. */
export const ASK_TIMEOUT_DEFAULT_MS = 50_000
export const PROGRESS_NOTE_MAX = 500

/**
 * Resolve the ask window: workspace option first, then the
 * `VERTRAGUS_ASK_TIMEOUT_MS` environment override (used by the integration
 * harness to force the ticket path in milliseconds instead of a minute — it
 * must keep winning over any provider claim, or the harness could no longer
 * exercise tickets at all), then the caller's raised window (an agent whose
 * CLI tolerates long MCP tool calls blocks instead of ticketing — every
 * `answer: null` round trip is a full model turn), then the 50 s default.
 */
export function resolveAskTimeoutMs(
  configured: number | undefined,
  env: NodeJS.ProcessEnv = process.env,
  raisedMs?: number
): number {
  if (configured !== undefined && Number.isFinite(configured) && configured > 0) return configured
  const raw = Number(env.VERTRAGUS_ASK_TIMEOUT_MS)
  if (Number.isFinite(raw) && raw > 0) return raw
  if (raisedMs !== undefined && Number.isFinite(raisedMs) && raisedMs > 0) return raisedMs
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
        'may call this again for every follow-up task you receive. If your task specifies a result ' +
        'schema, you MUST pass a matching result — an invalid one comes back as an error and your ' +
        'report is not delivered until it validates. Without a schema, result is optional and passed ' +
        'to the orchestrator as-is (serialized size capped at 8000 characters — larger is an error).',
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
          ),
        result: z
          .unknown()
          .optional()
          .describe(
            'Structured result. Required and validated when your task states a result schema; ' +
              'otherwise optional, delivered as-is when small enough'
          )
      }
    },
    async ({ summary, status, result }): Promise<ToolText> => {
      // S3: the schema-vetted structured report. The retry loop runs HERE, at
      // the child — the parent only ever sees the validated end state, so a
      // failed validation must push NO event (the summary is "not delivered").
      const schema = runtime.resultSchemas.get(agentId)
      const serialized = result === undefined ? undefined : JSON.stringify(result)
      const problems: string[] = []
      if (schema) {
        if (result === undefined) {
          problems.push('result: missing — your task states a result schema; pass a matching result')
        } else {
          problems.push(...validateResult(schema, result))
        }
      }
      if (serialized !== undefined && serialized.length > RESULT_MAX_CHARS) {
        problems.push(
          `result: serialized result is ${serialized.length} chars — the cap is ${RESULT_MAX_CHARS}. Report the essentials, not the raw data.`
        )
      }
      if (problems.length > 0) {
        return toolError({
          error: 'invalid_result',
          problems,
          note: 'Call report_done again with a corrected result. Your summary was NOT delivered yet.'
        })
      }
      const payload = {
        type: 'agent_done' as const,
        ...identity(),
        summary,
        status: status ?? 'success',
        ...(result !== undefined ? { result: result as JsonValue } : {})
      }
      // C3: the host snapshots — a dirty worktree is committed onto the
      // agent's branch first, so baseBranch chaining points at the work. A
      // git hiccup must not swallow the done report — the summary is still
      // the agent's word; the orchestrator can inspect_agent afterwards.
      // F: the report lands in the PARENT's queue — a lead's child reports to
      // the lead, not to the root.
      const queue = queueForAgent(runtime, agentId)
      let headSha: string | undefined
      try {
        const facts = await ctx.host.snapshotDone(agentId, summary)
        headSha = facts.headSha
        queue.push({ ...payload, ...worktreeEventFields(facts) })
      } catch {
        queue.push(payload)
      }
      // S4: the same path also lands on the task board — lastReport on every
      // task this agent owns. Display facts only; the status NEVER moves here
      // (completing is the orchestrator's explicit decision after verification).
      runtime.taskBoard?.noteReport(agentId, {
        status: payload.status,
        summary,
        ...(headSha ? { headSha } : {})
      })
      // A3: the profile's adoption automation (auto-integrate into the
      // orchestrator's worktree, auto-promote into the checkout). Deliberately
      // NOT awaited and never able to fail this call: the report is delivered,
      // and a merge that conflicts reports itself as an event.
      void ctx.host.adoptOnDone?.(agentId, payload.status).catch(() => undefined)
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
        'answer arrives. For a decision, pass 2–8 short labels in choices (at most 28); question is the ' +
        'prompt only — do not dump numbered options into it. If it returns answer: null, call it again ' +
        'with the returned ticket and the unchanged question. Never guess an answer and never continue without one.',
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
      // Per CALLER, not per workspace: the window an agent may block is bounded
      // by ITS OWN CLI's MCP tool timeout, and a run happily mixes a claude
      // worker (raised) with a codex worker (60 s default). Resolved per call —
      // cheap, and the host owns the provider lookup.
      const timeoutMs = resolveAskTimeoutMs(
        ctx.askTimeoutMs,
        process.env,
        ctx.host.askTimeoutMsFor?.(agentId)
      )

      if (ticket) {
        // Ignore leftover/empty/invalid `choices` — they must not block resume.
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
      const newChoices = alreadyOpen ? undefined : parseNewAskChoices(choices)
      const pending =
        alreadyOpen ??
        runtime.questions.create(agentId, question, {
          ...(newChoices ? { choices: newChoices } : {})
        })
      if (!alreadyOpen) {
        // F: questions climb exactly ONE level — the event goes to the
        // asking agent's parent (lead or root), never skip-level.
        queueForAgent(runtime, agentId).push({
          type: 'agent_question',
          ...identity(),
          questionId: pending.questionId,
          question,
          ...(pending.choices && pending.choices.length > 0 ? { choices: pending.choices } : {})
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
        'Report a real milestone in one line (not a heartbeat). The orchestrator sees it with its ' +
        'next wake-up; it does not reply to it.',
      inputSchema: {
        note: z.string().min(1).max(PROGRESS_NOTE_MAX).describe('What you just achieved, one line')
      }
    },
    async ({ note }): Promise<ToolText> => {
      try {
        // Quiet: a milestone note never needs a reaction — it rides along
        // with the orchestrator's next wake instead of costing it a turn.
        queueForAgent(runtime, agentId).push(
          { type: 'agent_progress', ...identity(), note },
          { quiet: true }
        )
      } catch (error) {
        return toolError({ error: 'progress_failed', message: errorMessage(error) })
      }
      return toolJson({ ok: true })
    }
  )
}
