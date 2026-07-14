/**
 * Orchestrator / task-graph types shared across processes.
 *
 * The orchestrator agent decomposes a goal into tasks and dispatches each to a
 * subagent via the Orca MCP server. The engine tracks them as a simple DAG.
 */
import type { AgentProviderId } from './providers'
import type { AgentUsage } from './agents'
import type { PlannerConfig } from './profile'
import type { RunRetro } from './retro'

export type TaskStatus = 'queued' | 'running' | 'success' | 'needs-work' | 'error' | 'stopped'

export type TaskCriticality = 'required' | 'advisory'
export type TaskFailureKind = 'infrastructure' | 'worker' | 'gate' | 'cancelled'

export type TaskPhase =
  | 'queued'
  | 'preflight'
  | 'starting'
  | 'working'
  | 'testing'
  | 'committing'
  | 'integrating'
  | 'security-review'
  | 'completed'

export type OrchestratorActivityPhase =
  | 'idle'
  | 'planning'
  | 'awaiting-review'
  | 'delegating'
  | 'monitoring'
  | 'reviewing'
  | 'integrating'
  | 'summarizing'
  | 'completed'
  | 'blocked'

/** Explicit, user-facing account of what the coordinator is doing right now. */
export interface OrchestratorActivity {
  phase: OrchestratorActivityPhase
  /** One concise sentence suitable for the live status card. */
  summary: string
  /** Concrete checks or coordination actions currently in progress. */
  details: string[]
  /** What the orchestrator intends to do after the current action. */
  nextStep?: string
  updatedAt: number
}

export type TaskCompletion =
  | { kind: 'commit'; commit: string }
  | { kind: 'no-changes' }

export interface TaskGateFinding {
  gate: 'security' | 'quality' | 'commit' | 'preflight'
  code: string
  message: string
  files?: string[]
  missingControls?: string[]
}

export interface TaskBlocker {
  kind: TaskFailureKind
  code: string
  summary: string
  details: string[]
  recoverable: boolean
}

export interface TaskRecoveryArtifact {
  /** Verified Orca worktree whose files remain available for audit or retry. */
  worktree: string
  baseCommit?: string
  changedFiles: string[]
  statusSummary: string
  capturedAt: number
}

export type PanePreflightCheckId =
  | 'provider'
  | 'provider-runtime'
  | 'workspace'
  | 'git-common-dir'
  | 'dependencies'
  | 'toolchain'
  | 'identity'

export interface PanePreflightCheck {
  id: PanePreflightCheckId
  status: 'passed' | 'warning' | 'failed'
  detail: string
  durationMs: number
}

export interface PanePreflightReport {
  status: 'passed' | 'failed'
  provider: AgentProviderId
  workspaceId: string
  engineId?: string
  workspaceSessionId?: string
  startedAt: number
  completedAt: number
  checks: PanePreflightCheck[]
}

export interface TaskAttemptSnapshot {
  attempt: number
  agentId?: string
  agentName?: string
  provider?: AgentProviderId
  model?: string
  status: Extract<TaskStatus, 'running' | 'success' | 'needs-work' | 'error' | 'stopped'>
  startedAt: number
  finishedAt?: number
  failureKind?: TaskFailureKind
  note?: string
}

export type RemoteCiStatus =
  | 'waiting'
  | 'pending'
  | 'passed'
  | 'failed'
  | 'cancelled'
  | 'timed-out'
  | 'unavailable'

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
  /** Required tasks decide the plan outcome; advisory tasks may fail without blocking delivery. */
  criticality?: TaskCriticality
  ownership?: 'feature' | 'integrator'
  /** Stable id from the authored plan, separate from the runtime task id. */
  planTaskId?: string
  /** 0..100, best-effort. */
  progress?: number
  /** Structured lifecycle phase for long-running worker visibility. */
  phase?: TaskPhase
  /** Last meaningful worker action, kept intentionally short for the DAG card. */
  lastAction?: string
  /** Most recent distinct worker actions (newest first) for the live sidebar. */
  recentActions?: string[]
  /** Updated by worker output and the periodic lifecycle heartbeat. */
  lastHeartbeatAt?: number
  /** Provider-reported token/cost telemetry, updated live where available. */
  usage?: AgentUsage
  /** One-line note (error text, block reason, result preview). */
  note?: string
  /** Runtime task ids that must finish successfully before this task may start. */
  dependsOn?: string[]
  /** Dependencies that must finish, but whose failure does not block this task. */
  advisoryDependsOn?: string[]
  /** Resources/files that must not be worked on concurrently inside one plan. */
  conflictKeys?: string[]
  /** Groups tasks that were submitted as one validated execution plan. */
  planId?: string
  engineId?: string
  expectedFiles?: string[]
  /** Quarantined partial work from a failed worker; never auto-integrated. */
  recoveryArtifact?: TaskRecoveryArtifact
  worktree?: string
  branch?: string
  commit?: string
  /** A successful implementation must prove a commit or explicitly report no changes. */
  completion?: TaskCompletion
  findings?: TaskGateFinding[]
  blocker?: TaskBlocker
  failureKind?: TaskFailureKind
  preflight?: PanePreflightReport
  attempts?: TaskAttemptSnapshot[]
  prUrl?: string
  /** Auto-PR is independent from the agent execution status. */
  autoPrStatus?: 'skipped' | 'prepared' | 'published' | 'blocked'
  /** Remote GitHub checks are tracked separately from successful PR publication. */
  remoteCiStatus?: RemoteCiStatus
  /** Best available check or pull-request URL for remote CI. */
  remoteCiUrl?: string
  /** Human-readable remote CI result or diagnostic. */
  remoteCiSummary?: string
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

export interface WorkspaceSessionSummary {
  id: string
  profileId: string
  profileName: string
  sequence: number
  name: string
  startedAt: number
  active: boolean
}

export interface OrchestratorSnapshot {
  /** Workspace ownership for multi-session renderer routing. */
  profileId?: string
  workspaceSessionId?: string
  engineId?: string
  /** Effective planning mode for this workspace session. */
  plannerMode?: PlannerConfig['mode']
  goal: OrchestratorGoal | null
  activity?: OrchestratorActivity
  tasks: OrcaTask[]
  capacity?: OrchestratorCapacitySnapshot
  reliability?: OrchestratorReliabilityMetrics
  pendingPlan?: PendingPlanReview
  /** Retrospective of the most recent terminal plan run in this session. */
  lastRetro?: RunRetro
}

export interface OrchestratorReliabilityMetrics {
  dispatchAttempts: number
  preflightPassed: number
  preflightFailed: number
  infrastructureFailures: number
  automaticRecoveries: number
  needsWorkTasks: number
  rescuedNeedsWorkCommits: number
  completedPlans: number
  preventedFalseSuccesses: number
  lastSnapshotAt: number
  maxRunningStatusAgeMs: number
  timeToFirstUsefulCommitMs?: number
  failuresByProviderAndPlatform: Record<string, number>
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
  title?: string
  role?: string
  agentId?: string
  agentName?: string
  provider?: AgentProviderId
  model?: string
  status: TaskStatus
  criticality?: TaskCriticality
  ownership?: 'feature' | 'integrator'
  planTaskId?: string
  phase?: TaskPhase
  progress?: number
  lastAction?: string
  recentActions?: string[]
  lastHeartbeatAt?: number
  usage?: AgentUsage
  result?: string
  error?: string
  note?: string
  completion?: TaskCompletion
  findings?: TaskGateFinding[]
  blocker?: TaskBlocker
  failureKind?: TaskFailureKind
  preflight?: PanePreflightReport
  recoveryArtifact?: TaskRecoveryArtifact
  attempts?: TaskAttemptSnapshot[]
}

export interface PlanRunStatusSnapshot {
  runId: string
  status: 'running' | 'success' | 'needs-work' | 'error' | 'stopped'
  engineId?: string
  workspaceSessionId?: string
  planId?: string
  goal?: string
  tasks?: TaskStatusSnapshot[]
  summary?: {
    required: number
    advisory: number
    running: number
    succeeded: number
    needsWork: number
    failed: number
  }
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
  /** Routing knowledge exposed to the orchestrator. */
  strengths: string[]
  weaknesses: string[]
  /** Knowledge accumulated from retros and benchmarks of earlier runs. */
  learnedStrengths?: string[]
  learnedWeaknesses?: string[]
  available: boolean
  preflight?: PanePreflightReport
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
  /** Wait for these tasks, consume their result when present, but never block on failure. */
  advisoryDependsOn: string[]
  /** Only required tasks participate in the plan's success decision. */
  criticality: TaskCriticality
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
  status: Extract<TaskStatus, 'success' | 'needs-work' | 'error' | 'stopped'>
  criticality: TaskCriticality
  result: string
  commit?: string
  findings?: TaskGateFinding[]
}

export interface ExecutionPlanResult {
  planId: string
  status: Extract<PlanRunStatusSnapshot['status'], 'success' | 'needs-work' | 'error' | 'stopped'>
  usedFallback: boolean
  validationIssues: PlanValidationIssue[]
  tasks: ExecutionPlanTaskResult[]
}
