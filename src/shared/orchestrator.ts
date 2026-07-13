/**
 * Orchestrator / task-graph types shared across processes.
 *
 * The orchestrator agent decomposes a goal into tasks and dispatches each to a
 * subagent via the Orca MCP server. The engine tracks them as a simple DAG.
 */
import type { AgentProviderId } from './providers'

export type TaskStatus = 'queued' | 'running' | 'success' | 'error' | 'stopped'

export type TaskPhase =
  | 'queued'
  | 'starting'
  | 'working'
  | 'testing'
  | 'committing'
  | 'integrating'
  | 'security-review'
  | 'completed'

export type TaskCompletion =
  | { kind: 'commit'; commit: string }
  | { kind: 'no-changes' }

export interface OrcaTask {
  id: string
  /** Short title shown on the DAG card. */
  title: string
  /** Requested subagent role (matches a profile slot role). */
  role: string
  /** The agent instance the task was dispatched to (pane id), if any. */
  agentId?: string
  /** Code-name of the subagent handling it, e.g. "Legolas". */
  agentName?: string
  provider?: AgentProviderId
  model?: string
  status: TaskStatus
  /** 0..100, best-effort. */
  progress?: number
  /** Structured lifecycle phase for long-running worker visibility. */
  phase?: TaskPhase
  /** Last meaningful worker action, kept intentionally short for the DAG card. */
  lastAction?: string
  /** Updated by worker output and the periodic lifecycle heartbeat. */
  lastHeartbeatAt?: number
  /** One-line note (error text, block reason, result preview). */
  note?: string
  /** Runtime task ids that must finish successfully before this task may start. */
  dependsOn?: string[]
  /** Resources/files that must not be worked on concurrently inside one plan. */
  conflictKeys?: string[]
  /** Groups tasks that were submitted as one validated execution plan. */
  planId?: string
  worktree?: string
  branch?: string
  commit?: string
  /** A successful implementation must prove a commit or explicitly report no changes. */
  completion?: TaskCompletion
  prUrl?: string
  /** Auto-PR is independent from the agent execution status. */
  autoPrStatus?: 'skipped' | 'prepared' | 'published' | 'blocked'
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

export interface PendingPlanReview {
  planId: string
  plan: ExecutionPlan
  validationIssues: PlanValidationIssue[]
}

export interface OrchestratorSnapshot {
  /** Workspace ownership for multi-session renderer routing. */
  profileId?: string
  workspaceSessionId?: string
  goal: OrchestratorGoal | null
  tasks: OrcaTask[]
  capacity?: OrchestratorCapacitySnapshot
  pendingPlan?: PendingPlanReview
}

/** One mental model for warm panes, scheduler slots, provider gates and queues. */
export interface OrchestratorCapacitySnapshot {
  warmInteractiveAgents: number
  maxTaskParallelism: number
  configuredRoleCapacity: number
  activeTasks: number
  waitingTasks: number
}

/** Polling response returned by the asynchronous MCP task API. */
export interface TaskStatusSnapshot {
  taskId: string
  status: TaskStatus
  phase?: TaskPhase
  progress?: number
  lastAction?: string
  lastHeartbeatAt?: number
  result?: string
  error?: string
  completion?: TaskCompletion
}

export interface PlanRunStatusSnapshot {
  runId: string
  status: 'running' | 'success' | 'error'
  result?: ExecutionPlanResult
  error?: string
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

/** Provider features needed to act as Orca's top-level orchestrator. */
export interface OrchestratorProviderCapability {
  provider: AgentProviderId
  supported: boolean
  transport: 'mcp-http' | 'none'
  transientConfig: boolean
  reason?: string
}

/** A single node in an orchestrator-generated execution DAG. */
export interface ExecutionPlanTask {
  /** Stable within the plan; limited to safe identifier characters. */
  id: string
  title: string
  role: string
  prompt: string
  dependsOn: string[]
  /** Tasks sharing a key never run at the same time. */
  conflictKeys: string[]
  /** Shared-hotspot ownership is explicit and limited to one final integrator task. */
  ownership: 'feature' | 'integrator'
  /** Best-effort declared write set used for ownership validation. */
  expectedFiles: string[]
}

/** Structured plan produced by an orchestrator after inspecting available slots. */
export interface ExecutionPlan {
  version: 1
  goal: string
  /** Global plan concurrency, in addition to each role's configured capacity. */
  maxParallel: number
  tasks: ExecutionPlanTask[]
}

export type PlanValidationCode =
  | 'invalid_shape'
  | 'invalid_goal'
  | 'invalid_parallelism'
  | 'invalid_task'
  | 'invalid_ownership'
  | 'too_many_tasks'
  | 'duplicate_task_id'
  | 'unknown_dependency'
  | 'dependency_cycle'

export interface PlanValidationIssue {
  code: PlanValidationCode
  message: string
  taskId?: string
}

export interface ResolvedExecutionPlan {
  plan: ExecutionPlan
  /** True when validation replaced the proposed DAG with one conservative task. */
  usedFallback: boolean
  issues: PlanValidationIssue[]
}

export interface ExecutionPlanTaskResult {
  id: string
  status: Extract<TaskStatus, 'success' | 'error' | 'stopped'>
  result: string
}

export interface ExecutionPlanResult {
  planId: string
  usedFallback: boolean
  validationIssues: PlanValidationIssue[]
  tasks: ExecutionPlanTaskResult[]
}
