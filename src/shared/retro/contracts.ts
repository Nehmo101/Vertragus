/**
 * Process-independent contracts for retrospective run analysis.
 *
 * Keep this module data-only: main-process persistence, renderer presentation
 * and the analysis functions all consume these shapes without depending on an
 * implementation module.
 */
import type { AgentUsage } from '../agents'
import type {
  TaskBlocker,
  TaskFailureKind,
  TaskGateFinding,
  TaskStatus,
  TaskStatusSnapshot
} from '../orchestrator'
import type {
  OrchestratorDelegationEstimate,
  PlanDelegationEstimate
} from '../planEstimate'
import type { AgentProviderId } from '../providers'

export type LearningKind = 'strength' | 'weakness'
export type LearningSource = 'auto-retro' | 'orchestrator' | 'benchmark'

/** One persisted per-model insight, e.g. "sehr stark bei UI-Aufgaben". */
export interface ModelLearning {
  id: string
  provider: AgentProviderId
  /** Resolved model name; empty string = provider CLI default. */
  model: string
  /** Role context the insight was observed in, e.g. "frontend". */
  role?: string
  kind: LearningKind
  /** Short German insight suitable for routing decisions. */
  insight: string
  /** Concrete observation backing the insight (run stats, score, verdict). */
  evidence?: string
  source: LearningSource
  profileId?: string
  /** How often this insight was (re-)confirmed across runs. */
  observations: number
  createdAt: number
  updatedAt: number
}

/** A learning before it is merged into the persistent store. */
export interface NewModelLearning {
  provider: AgentProviderId
  model: string
  role?: string
  kind: LearningKind
  insight: string
  evidence?: string
  source: LearningSource
  profileId?: string
}

export type RetroFailureKind = 'infra' | 'cancelled' | 'model'

/** Mutually exclusive causes for terminal failures in one plan run. */
export interface RetroFailureBreakdown {
  infra: number
  cancelled: number
  model: number
}

/** Aggregated per provider/model stats for one plan run. */
export interface RetroModelStats {
  provider: AgentProviderId
  model: string
  roles: string[]
  tasks: number
  succeeded: number
  needsWork: number
  failed: number
  stopped: number
  /** Error/stopped task outcomes split by their actual cause. */
  failuresByKind: RetroFailureBreakdown
  /** Worker-attempt failures attributed to this model (incl. rerouted tasks). */
  failedAttempts: number
  /** Failed worker attempts split independently from terminal task outcomes. */
  failedAttemptsByKind: RetroFailureBreakdown
  gateFindings: number
  avgDurationMs?: number
  tokensIn?: number
  tokensOut?: number
  costUsd?: number
}

/** Copy-ready qualitative learning entry emitted by get_retro_draft. */
export interface RetroLearningTemplate {
  provider: AgentProviderId
  /** Resolved telemetry model name; never empty in a generated draft. */
  model: string
  role: string
  kind: LearningKind
  insight: string
  evidence: string
}

/** Stable task outcome counters for one model in a retro draft. */
export interface RetroTaskBalance {
  total: number
  success: number
  needsWork: number
  failed: number
  stopped: number
}

/** Facts and a copy-ready qualitative learning template for one model. */
export interface RetroDraftModel {
  provider: AgentProviderId
  /** Resolved telemetry model name; never empty in a generated draft. */
  model: string
  roles: string[]
  taskBalance: RetroTaskBalance
  failuresByKind: RetroFailureBreakdown
  failedAttempts: number
  failedAttemptsByKind: RetroFailureBreakdown
  gateFindings: number
  avgDurationMs: number | null
  /** 1 = fastest model with timing data; null when no duration was reported. */
  speedRank: number | null
  tokensIn: number | null
  tokensOut: number | null
  costUsd: number | null
  /** Single best-guess slot (kept for backward compatibility). */
  learningTemplate: RetroLearningTemplate
  /**
   * Symmetric fill-in slots — one strength and one weakness per model — so the
   * orchestrator is prompted to weigh both sides. A slot may stay empty when no
   * evidence supports it; never invent a weakness.
   */
  learningTemplates: RetroLearningTemplate[]
}

export type RetroDraftUnavailableCode =
  | 'no-terminal-plan'
  | 'plan-not-found'
  | 'plan-not-terminal'
  | 'no-model-stats'

/** Facts scaffold returned to the orchestrator before it calls record_retro. */
export type RetroDraftResult =
  | {
      ok: true
      planId: string
      goal: string
      status: NonNullable<RunRetro['status']>
      summary: string
      models: RetroDraftModel[]
      /** Estimate-vs-actual delegation scorecard for this run, when available. */
      delegation?: DelegationRetro
    }
  | {
      ok: false
      code: RetroDraftUnavailableCode
      message: string
      planId?: string
    }

/** Minimal per-task shape the delegation analysis consumes. */
export interface DelegationTaskObservation {
  status: TaskStatus
  /** The task produced a real commit (completion.kind === 'commit'). */
  committed: boolean
  /** The task explicitly reported that it changed nothing. */
  noChanges: boolean
  startedAt?: number
  finishedAt?: number
}

/** What actually happened to the delegated team in one plan run. */
export interface DelegationOutcome {
  /** Subagent tasks that reached a terminal state. */
  dispatchedTasks: number
  /** Tasks that produced a real commit. */
  committedTasks: number
  /** Terminal tasks that reported no changes. */
  noChangeTasks: number
  /** Tasks that failed or were stopped. */
  failedTasks: number
  /** Best-effort peak of tasks observed running at the same time. */
  observedPeakParallel: number
}

/** Was the estimated delegation decision borne out by what the run did? */
export type DelegationVerdict = 'justified' | 'overhead' | 'inconclusive'

/** How the orchestrator's own prediction held up against reality. */
export type CalibrationGrade = 'accurate' | 'over-delegated' | 'under-delegated' | 'unclear'

/** Calibration of the orchestrator's self-estimate against structure + outcome. */
export interface SelfCalibration {
  /** Did the self-estimate agree with the deterministic structural estimate? */
  agreedWithStructure: boolean
  /** Was the self-estimate borne out by the real outcome? */
  grade: CalibrationGrade
  note: string
}

/**
 * The estimate the engine derived from the plan, paired with the actual run
 * outcome and a verdict. Recorded on the retro so the solo-vs-team decision
 * becomes measurable over time instead of staying a matter of prompt vibes.
 * When the orchestrator recorded its own pre-plan estimate, the calibration of
 * that self-judgement against structure and outcome is captured too.
 */
export interface DelegationRetro {
  estimate: PlanDelegationEstimate
  /** The orchestrator's own pre-plan prediction, when it recorded one. */
  selfEstimate?: OrchestratorDelegationEstimate
  outcome: DelegationOutcome
  verdict: DelegationVerdict
  /** How the orchestrator's own prediction held up against reality. */
  selfCalibration?: SelfCalibration
  /** Concise German explanation comparing estimate to outcome. */
  note: string
}

/** Retrospective of one plan run (or an ad-hoc orchestrator retro). */
export interface RunRetro {
  id: string
  profileId?: string
  workspaceSessionId?: string
  planId: string
  goal: string
  /** Absent for ad-hoc retros recorded outside a plan run. */
  status?: 'success' | 'needs-work' | 'error' | 'stopped'
  summary: string
  modelStats: RetroModelStats[]
  /** Learnings recorded for this run (heuristic + orchestrator). */
  learnings: ModelLearning[]
  /** Estimate-vs-actual on whether delegating a team was warranted. */
  delegation?: DelegationRetro
  /** Set when this card has been handed to the export queue. */
  exportQueuedAt?: number
  createdAt: number
}

/**
 * Minimal task projection accepted by the run analyzer.
 * OrcaTask is structurally compatible, but the analyzer stays independent of
 * the complete orchestration schema and can be reused by import/export tools.
 */
export interface RetroTaskObservation {
  role: string
  provider?: AgentProviderId
  model?: string
  status: 'queued' | 'running' | 'waiting' | 'paused' | 'success' | 'needs-work' | 'error' | 'stopped'
  failureKind?: TaskFailureKind
  note?: string
  judgeReason?: string
  blocker?: TaskBlocker
  createdAt: number
  finishedAt?: number
  usage?: AgentUsage
  findings?: readonly TaskGateFinding[]
  attempts?: ReadonlyArray<{
    provider?: AgentProviderId
    model?: string
    status: 'running' | 'success' | 'needs-work' | 'error' | 'stopped'
    failureKind?: TaskFailureKind
    note?: string
  }>
}

/** Input for the complete, side-effect-free run analysis. */
export interface AnalyzeRunRetroInput {
  tasks: readonly RetroTaskObservation[]
  status?: RunRetro['status']
  profileId?: string
}

/** Output persisted by the engine after model learnings have been merged. */
export interface RunRetroAnalysis {
  summary: string
  modelStats: RetroModelStats[]
  learnings: NewModelLearning[]
}

/** One scored contestant of a benchmark run, judged by the orchestrator. */
export interface BenchmarkRanking {
  role: string
  provider?: AgentProviderId
  model?: string
  /** 0..10 as judged by the orchestrator. */
  score: number
  verdict: string
  strengths: string[]
  weaknesses: string[]
  durationMs?: number
  tokens?: number
}

export interface BenchmarkRecord {
  id: string
  benchmarkId: string
  profileId?: string
  /** The shared task every slot executed. */
  task: string
  summary: string
  rankings: BenchmarkRanking[]
  createdAt: number
}

/** Live/polling view of a benchmark fan-out. */
export interface BenchmarkRunStatus {
  benchmarkId: string
  title: string
  status: 'running' | 'completed'
  tasks: Array<TaskStatusSnapshot & { durationMs?: number }>
}
