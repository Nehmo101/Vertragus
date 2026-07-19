/**
 * Orchestrator / task-graph types shared across processes.
 *
 * The orchestrator agent decomposes a goal into tasks and dispatches each to a
 * subagent via the Vertragus MCP server. The engine tracks them as a simple DAG.
 */
import type { AgentProviderId } from './providers'
import type { AgentUsage } from './agents'
import type { PlanDelegationEstimate } from './planEstimate'
import type { PlannerConfig } from './profile'
import type { RetroDraftResult, RunRetro } from './retro'
import type { ApprovalItem, PermissionRequest, RemoteBudgetSnapshot } from './remote'
import type { WorkspaceGitPostProcessingSnapshot } from './gitPostProcessing'

export type TaskStatus = 'queued' | 'running' | 'waiting' | 'paused' | 'success' | 'needs-work' | 'error' | 'stopped'

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
  /** Verified Vertragus worktree whose files remain available for audit or retry. */
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
  /** Code-name of the subagent handling it, e.g. "Caronte". */
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
  /** Concrete reason produced by the terminal-result judge, especially for error states. */
  judgeReason?: string
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
  /** Denied tool-permission requests during this task; no-changes plus denials is never a success. */
  permissionDenials?: number
  preflight?: PanePreflightReport
  attempts?: TaskAttemptSnapshot[]
  prUrl?: string
  /** Auto-PR is independent from the agent execution status. */
  autoPrStatus?: 'skipped' | 'prepared' | 'published' | 'blocked'
  /** Competing-candidate group metadata for Multiagent mode. */
  multiAgentRunId?: string
  multiAgentParentTaskId?: string
  multiAgentCandidate?: number
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

export type MultiAgentRunStatus = 'running' | 'awaiting-review' | 'accepted' | 'rejected'

export interface MultiAgentRunSnapshot {
  id: string
  parentTaskId: string
  title: string
  role: string
  status: MultiAgentRunStatus
  candidateTaskIds: string[]
  winnerTaskId?: string
  feedback?: string
  startedAt: number
  decidedAt?: number
}

export interface SubagentSupportRequest {
  id: string
  taskId: string
  agentName?: string
  role?: string
  question: string
  context?: string
  status: 'pending' | 'answered' | 'stopped'
  response?: string
  createdAt: number
  respondedAt?: number
}

export type SubagentFindingKind = 'interface' | 'decision' | 'blocker' | 'insight'

/**
 * One entry on the shared findings board. Subagents post interface contracts,
 * decisions, blockers and insights here so parallel workers (and the
 * orchestrator) can coordinate without waiting for terminal task results.
 */
export interface SubagentFinding {
  id: string
  /** Runtime task id of the reporting worker. */
  taskId: string
  /** Plan scope; findings without a plan are visible to every task. */
  planId?: string
  agentName?: string
  role?: string
  kind: SubagentFindingKind
  title: string
  detail: string
  files?: string[]
  createdAt: number
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
  usedFallback: boolean
  rejected: boolean
  validationIssues: PlanValidationIssue[]
}

export interface WorkspaceSessionSummary {
  id: string
  profileId: string
  profileName: string
  sequence: number
  name: string
  /** Concise description of the active work in this workspace session. */
  taskSummary: string | undefined
  startedAt: number
  active: boolean
}

export const TASK_SUMMARY_MAX_LENGTH = 120

const TASK_SUMMARY_ACTIVE_STATUSES = new Set<TaskStatus>([
  'queued',
  'running',
  'waiting',
  'paused'
])

function normalizeTaskSummary(value: string | undefined): string {
  return value?.replace(/\s+/g, ' ').trim() ?? ''
}

function truncateTaskSummary(value: string): string {
  if (value.length <= TASK_SUMMARY_MAX_LENGTH) return value
  return `${value.slice(0, TASK_SUMMARY_MAX_LENGTH - 1).trimEnd()}…`
}

/** Derive one bounded display line from authoritative workspace orchestration state. */
export function deriveTaskSummary(
  snapshot: Pick<OrchestratorSnapshot, 'goal' | 'activity' | 'tasks'>
): string | undefined {
  const activeTask = snapshot.tasks.find((task) => TASK_SUMMARY_ACTIVE_STATUSES.has(task.status))
  const goalTitle = snapshot.goal?.active
    ? normalizeTaskSummary(snapshot.goal.title)
    : ''
  const activitySummary = normalizeTaskSummary(snapshot.activity?.summary)
  const activityIsActive = Boolean(
    snapshot.activity && snapshot.activity.phase !== 'idle' && snapshot.activity.phase !== 'completed'
  )
  const meaningfulGoalIsActive = Boolean(
    goalTitle &&
    goalTitle !== 'Orchestrator aktiv' &&
    snapshot.activity?.phase !== 'idle' &&
    snapshot.activity?.phase !== 'completed'
  )

  if (!activeTask && !activityIsActive && !meaningfulGoalIsActive) return undefined

  const summary = meaningfulGoalIsActive
    ? goalTitle
    : normalizeTaskSummary(activeTask?.title) || activitySummary
  return summary ? truncateTaskSummary(summary) : undefined
}

export interface IntegrationCenterItem {
  taskId: string
  title: string
  status: NonNullable<OrcaTask['autoPrStatus']>
  /** Commit/branch identifiers are display-only; host worktree paths are never projected remotely. */
  commit?: string
  branch?: string
  prUrl?: string
  remoteCiStatus?: RemoteCiStatus
  remoteCiUrl?: string
  remoteCiSummary?: string
  findingCount: number
}

export interface IntegrationCenterSnapshot {
  status: 'idle' | 'prepared' | 'awaiting-approval' | 'publishing' | 'published' | 'blocked'
  pendingPublicationId?: string
  items: IntegrationCenterItem[]
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
  /** Unified approval projection; populated by Mission Control from the same snapshot bus. */
  pendingApprovals?: ApprovalItem[]
  /** Provider tool prompts waiting in Vertragus' internal permission broker. */
  pendingPermissions?: PermissionRequest[]
  /** Aggregated provider telemetry plus restrictive remote caps for this session. */
  budget?: RemoteBudgetSnapshot
  /** Path-free aggregation state for the desktop/mobile Diff & Merge Center. */
  integration?: IntegrationCenterSnapshot
  /** Optional commit/push step belonging to the terminal workspace lifecycle. */
  gitPostProcessing?: WorkspaceGitPostProcessingSnapshot
  /** Retrospective of the most recent terminal plan run in this session. */
  lastRetro?: RunRetro
  /** Recent shared findings board entries (newest last), for the live UI. */
  findings?: SubagentFinding[]
  /** Competing candidate groups waiting for or carrying an orchestrator decision. */
  multiAgentRuns?: MultiAgentRunSnapshot[]
  /** Direct subagent questions/support requests, including answered history. */
  subagentRequests?: SubagentSupportRequest[]
}

export interface OrchestratorReliabilityMetrics {
  dispatchAttempts: number
  preflightPassed: number
  preflightFailed: number
  infrastructureFailures: number
  automaticRecoveries: number
  needsWorkTasks: number
  rescuedNeedsWorkCommits: number
  /** Quarantined worker results that passed every gate and were committed instead of discarded. */
  adoptedRecoveryArtifacts: number
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
  judgeReason?: string
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
  /** True when validation replaced unparseable input with one conservative task. */
  usedFallback?: boolean
  /** True when a structured but invalid plan was replaced by a review-gated fallback task. */
  rejected?: boolean
  /** Validation details are available on the initial execute_plan response. */
  validationIssues?: PlanValidationIssue[]
  /** Stable authored task ids, available before runtime task materialization. */
  planTaskIds?: string[]
  /** Deterministic solo-vs-team estimate derived from the plan structure. */
  estimate?: PlanDelegationEstimate
  /** Live state of the review gate; 'pending' means the plan waits for approval. */
  reviewState?: PlanReviewState
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

/**
 * Result of the blocking await_task tool: the orchestrator issues one call that
 * settles when the task is terminal (`done`), or returns `stillRunning` on the
 * long-poll timeout so it can re-await cheaply, or `unknown` for a missing id.
 */
export type AwaitTaskResult =
  | { done: true; stillRunning: false; task: TaskStatusSnapshot }
  | { done: false; stillRunning: true; reason: 'timeout'; task: TaskStatusSnapshot }
  | { done: false; stillRunning: false; reason: 'unknown'; taskId: string }

/**
 * Non-blocking reminder that the previous terminal plan run still has no
 * qualitative retro. Surfaced by set_goal so a new goal does not silently
 * drop the last run's model learnings.
 */
export interface RetroReminder {
  priorPlanId: string
  message: string
}

/** Result of the set_goal tool: carries an optional pending-retro reminder. */
export interface SetGoalResult {
  retroReminder?: RetroReminder
}

/**
 * Result of the blocking await_plan tool (see {@link AwaitTaskResult}).
 * On a terminal result the retro gate is surfaced: `retroPending` is true and
 * `retroDraft` carries the ready-to-fill scaffold until a qualitative retro has
 * been recorded for this run via record_retro.
 */
export type AwaitPlanResult =
  | {
      done: true
      stillRunning: false
      plan: PlanRunStatusSnapshot
      retroPending?: boolean
      retroDraft?: RetroDraftResult
    }
  | { done: false; stillRunning: true; reason: 'timeout'; plan: PlanRunStatusSnapshot }
  | { done: false; stillRunning: false; reason: 'unknown'; runId: string }

/** Review-gate state of a plan run, exposed so nobody has to poll for approval. */
export type PlanReviewState = 'pending' | 'approved' | 'rejected' | 'not-required'

/**
 * Result of the blocking await_plan_approval tool: settles on the panel
 * decision (approve/reject) instead of forcing the orchestrator to poll
 * list_tasks/get_plan_status until tasks start moving.
 */
export type AwaitPlanApprovalResult =
  | { done: true; stillRunning: false; reviewState: PlanReviewState; plan: PlanRunStatusSnapshot }
  | { done: false; stillRunning: true; reason: 'timeout'; reviewState: 'pending'; plan: PlanRunStatusSnapshot }
  | { done: false; stillRunning: false; reason: 'unknown'; runId: string }

/**
 * Result of the blocking await_any tool: settles with the first task to become
 * terminal plus the still-open `pending` ids, or `stillRunning` on timeout, or
 * `unknown` when none of the given ids are known.
 */
export type AwaitAnyResult =
  | { done: true; stillRunning: false; task: TaskStatusSnapshot; pending: string[] }
  | { done: false; stillRunning: true; reason: 'timeout'; tasks: TaskStatusSnapshot[] }
  | { done: false; stillRunning: false; reason: 'unknown'; unknownTaskIds: string[] }

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

/** Provider features needed to act as Vertragus' top-level orchestrator. */
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
  /** Non-fatal: an ownership issue was fixed in place instead of collapsing the plan. */
  | 'repaired_ownership'
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
  judgeReason?: string
}

export interface ExecutionPlanResult {
  planId: string
  status: Extract<PlanRunStatusSnapshot['status'], 'success' | 'needs-work' | 'error' | 'stopped'>
  usedFallback: boolean
  rejected: boolean
  validationIssues: PlanValidationIssue[]
  /** Side-effect-free run analysis persisted after the terminal task graph completed. */
  retro?: RunRetro
  tasks: ExecutionPlanTaskResult[]
}
