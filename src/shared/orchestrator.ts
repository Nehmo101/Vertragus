/**
 * Orchestrator / task-graph types shared across processes.
 *
 * The orchestrator agent decomposes a goal into tasks and dispatches each to a
 * subagent via the Orca MCP server. The engine tracks them as a simple DAG.
 */
import type { AgentProviderId } from './providers'

export type TaskStatus = 'queued' | 'running' | 'success' | 'error' | 'stopped'

export interface OrcaTask {
  id: string
  /** Short title shown on the DAG card. */
  title: string
  /** Requested subagent role (matches a profile slot role). */
  role: string
  /** The agent instance the task was dispatched to (pane id), if any. */
  agentId?: string
  provider?: AgentProviderId
  model?: string
  status: TaskStatus
  /** 0..100, best-effort. */
  progress?: number
  /** One-line note (error text, block reason, result preview). */
  note?: string
  yolo?: boolean
  createdAt: number
  finishedAt?: number
}

export interface OrchestratorGoal {
  id: string
  title: string
  /** Set once the orchestrator agent is running. */
  active: boolean
}

export interface OrchestratorSnapshot {
  goal: OrchestratorGoal | null
  tasks: OrcaTask[]
}

/** A subagent slot as advertised to the orchestrator via list_subagents. */
export interface SubagentDescriptor {
  role: string
  provider: AgentProviderId
  model: string
  /** How many parallel instances this slot allows. */
  capacity: number
  busy: number
}
