/**
 * S4: the task board schema — the durable plan OUTSIDE the model context.
 *
 * dsh pattern: `revision` is a CAS token (+1 per accepted mutation; a writer
 * must present the revision it last saw), `blockedBy` is an acyclic DAG over
 * taskIds, `deleted` is a tombstone (references to it are ignored in ready
 * computation instead of cascading). `lastReport` carries the host facts of
 * the owner's latest agent_done — display only, NEVER a status change:
 * completing a task stays an explicit orchestrator decision after
 * verification.
 */
import { z } from 'zod'
import { agentDoneStatusSchema } from './events'

export const TASK_STATUSES = ['pending', 'in_progress', 'completed', 'deleted'] as const
export type TaskStatus = (typeof TASK_STATUSES)[number]

export const taskSchema = z
  .object({
    taskId: z.string().regex(/^task-\d+$/),
    revision: z.number().int().positive(), // CAS: +1 per mutation
    subject: z.string().min(1).max(200),
    description: z.string().max(2_000).default(''),
    status: z.enum(TASK_STATUSES),
    ownerAgentId: z.string().min(1).optional(), // agent OR lead
    blockedBy: z.array(z.string()).max(20).default([]), // acyclic, no deleted
    /** Host facts of the owner's last agent_done — display, never a status change. */
    lastReport: z
      .object({
        status: agentDoneStatusSchema,
        summary: z.string().max(500),
        headSha: z.string().optional()
      })
      .optional(),
    createdAt: z.number(),
    updatedAt: z.number()
  })
  .strict()
export type Task = z.infer<typeof taskSchema>

export const taskBoardSchema = z
  .object({
    schemaVersion: z.literal(1),
    nextTaskNumber: z.number().int().positive(),
    tasks: z.array(taskSchema)
  })
  .strict()
export type TaskBoardState = z.infer<typeof taskBoardSchema>

export const TASKS_MAX = 200
