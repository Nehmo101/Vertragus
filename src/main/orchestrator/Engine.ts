/**
 * OrchestratorEngine — owns the live task graph and turns the orchestrator's
 * MCP tool calls into real subagent runs.
 *
 * Flow: the orchestrator agent (e.g. Claude/Fable) calls dispatch_subagent via
 * the Orca MCP server; the engine picks a matching profile slot, runs a
 * headless task agent (which shows up as a pane), waits for the result, updates
 * the DAG, and returns the result text to the orchestrator.
 */
import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import type {
  AwaitAnyResult,
  AwaitPlanApprovalResult,
  AwaitPlanResult,
  PlanReviewState,
  AwaitTaskResult,
  ExecutionPlan,
  ExecutionPlanResult,
  ExecutionPlanTask,
  ExecutionPlanTaskResult,
  OrcaTask,
  OrchestratorActivity,
  OrchestratorActivityPhase,
  OrchestratorGoal,
  IntegrationCenterSnapshot,
  MultiAgentRunSnapshot,
  OrchestratorReliabilityMetrics,
  PendingPlanReview,
  OrchestratorSnapshot,
  PlanRunStatusSnapshot,
  RetroReminder,
  SetGoalResult,
  SubagentDescriptor,
  SubagentFinding,
  SubagentFindingKind,
  SubagentSupportRequest,
  TaskAttemptSnapshot,
  TaskCriticality,
  TaskPhase,
  TaskStatus,
  TaskStatusSnapshot
} from '@shared/orchestrator'
import type {
  ApprovalItem,
  PermissionRequest,
  RemoteBudgetCaps,
  RemoteBudgetSnapshot
} from '@shared/remote'
import {
  agentSlotsWithRoles,
  agentSlotCapabilities,
  profileDefaultBaseBranch,
  type AgentSlot,
  type WorkspaceProfile
} from '@shared/profile'
import { resolveModel } from '@shared/models'
import { resolveSlotModel } from '@main/agents/providerModelDefaults'
import {
  isModelDisabled,
  normalizeDisabledModels,
  normalizeProviderEnabled,
  type AgentProviderId
} from '@shared/providers'
import { agentManager } from '@main/agents/AgentManager'
import { PanePreflightError } from '@main/agents/panePreflight'
import { detectLimit, stripAnsi } from '@main/agents/limitSignals'
import {
  hasExplicitWorkerBlocker,
  hasExplicitWorkerSuccess,
  type HeadlessResult
} from '@main/agents/headless'
import {
  getProfile,
  getActiveProfileId,
  getSetting,
  setSetting
} from '@main/config/store'
import { createPaneWindow } from '@main/windows'
import {
  prepareTaskChange,
  publishPreparedChanges,
  type PreparedTaskChange,
  type RemoteCiOutcome
} from '@main/integrations/autoPr'
import { resolveExecutionPlan } from '@main/orchestrator/planner'
import { Semaphore } from '@main/orchestrator/semaphore'
import { subagentOrcaToolsAvailable } from '@main/orchestrator/externalMcp'
import { securityChecklistForFiles } from '@main/integrations/securityGate'
import {
  analyzeRunRetro,
  benchmarkLearnings,
  deriveRetroDraftModels,
  type BenchmarkRanking,
  type BenchmarkRecord,
  type BenchmarkRunStatus,
  type LearningKind,
  type ModelLearning,
  type RetroDraftResult,
  type RunRetro
} from '@shared/retro'
import {
  learningsForModel,
  listRunRetros,
  recordBenchmarkRecord,
  recordModelLearnings,
  recordRunRetro
} from '@main/orchestrator/retroStore'
import { enqueueBenchmarkExport, enqueueRetroExport } from '@main/orchestrator/retroExport'
import { captureTaskRecoveryArtifact } from '@main/orchestrator/recoveryArtifact'
import { permissionBroker } from '@main/permissions/PermissionBroker'

interface DispatchOptions {
  taskId?: string
  planId?: string
  dependsOn?: string[]
  advisoryDependsOn?: string[]
  conflictKeys?: string[]
  expectedFiles?: string[]
  criticality?: TaskCriticality
  ownership?: 'feature' | 'integrator'
  planTaskId?: string
  attempt?: number
  maxAttempts?: number
  /** Verified failed-worker worktree whose partial files may be resumed. */
  recoveryWorktree?: string
  /** Internal marker that prevents a candidate from recursively opening another group. */
  multiAgentRunId?: string
  multiAgentParentTaskId?: string
  multiAgentCandidate?: number
}

interface DispatchRecord {
  role: string
  prompt: string
  title?: string
  options: DispatchOptions
}

interface MultiAgentOutcome {
  action: 'accepted' | 'rejected'
  message: string
}

interface MultiAgentRuntime extends MultiAgentRunSnapshot {
  prompt: string
  options: DispatchOptions
  nextCandidate: number
  resolve: (outcome: MultiAgentOutcome) => void
}

interface PreparedExecutionPlan {
  profile: WorkspaceProfile | undefined
  resolved: ReturnType<typeof resolveExecutionPlan>
  plan: ExecutionPlan
}

/** Workspace-Session-Id des Remote-Selftests (siehe src/main/remote/selftestRemote.ts). */
export const REMOTE_SELFTEST_SESSION_ID = 'remote-selftest'

const RESULT_PREVIEW = 160
/** Disk writes are throttled; the in-memory snapshot event stays immediate. */
const SNAPSHOT_PERSIST_MIN_INTERVAL_MS = 2_000
/** Bounded shared findings board (oldest entries are dropped first). */
const MAX_BOARD_FINDINGS = 200
const MAX_FINDINGS_RESPONSE = 50
/** Cap each injected dependency result so chained prompts stay bounded. */
const MAX_DEPENDENCY_CONTEXT_CHARS = 4_000
/** Blocking await_* long-poll window: replaces the repeated status-poll loop. */
const AWAIT_DEFAULT_TIMEOUT_MS = 25_000
const AWAIT_MIN_TIMEOUT_MS = 1_000
/** Stay safely below the common 60s MCP client request timeout. */
const AWAIT_MAX_TIMEOUT_MS = 55_000

/** A task status the orchestrator no longer needs to wait on. */
function isTerminalTaskStatus(status: TaskStatus): boolean {
  return status === 'success' || status === 'needs-work' || status === 'error' || status === 'stopped'
}
export function platformExecutionGuidance(
  platform: NodeJS.Platform = process.platform
): string[] {
  if (platform === 'win32') {
    return [
      'Windows/PowerShell: Nutze pro Tool-Aufruf einen kurzen Einzelbefehl.',
      "Windows/PowerShell: Nutze rg -g (z. B. rg -g '*.ts' Muster) statt Shell-Pfadglobs wie src/**/*.ts.",
      "Windows/PowerShell: rg mit Exit-Code 1 und leerem stderr bedeutet 'keine Treffer', nicht Infrastrukturfehler.",
      'Windows/PowerShell: Vereinfache nach Parser- oder Quotingfehlern den Aufruf; wiederhole ihn nicht unveraendert.'
    ]
  }
  if (platform === 'darwin') {
    return [
      'macOS/zsh: Nutze zsh-kompatible Befehle und beachte die BSD-Varianten von Tools wie sed, stat und date.'
    ]
  }
  return []
}

export function providerExecutionGuidance(
  provider: AgentProviderId,
  yolo: boolean,
  platform: NodeJS.Platform = process.platform
): string[] {
  if (provider !== 'codex' || yolo || platform !== 'win32') return []
  return [
    'Codex/Windows-Safe-Sandbox: Wenn ausschliesslich ein Node-Unterprozess mit spawn EPERM scheitert, ist das ein bekannter Sandbox-Gate-Fehler und kein fachlicher BLOCKER.',
    'Codex/Windows-Safe-Sandbox: Arbeite in diesem Fall weiter, kennzeichne nur den betroffenen Test/Build als nicht ausfuehrbar und schliesse bei fachlich vollstaendiger Arbeit mit ERGEBNIS: ERFOLG; Orcas Main-Prozess wiederholt die zentralen Abnahme-Gates ausserhalb der Worker-Sandbox.'
  ]
}

export interface WorkerTerminalJudgement {
  status: 'success' | 'error' | 'stopped'
  failureKind?: 'infrastructure' | 'worker' | 'cancelled'
  /**
   * Exit 0 without an explicit worker contract while the provider flagged an
   * error: contradictory signals. The acceptance gates may overrule this error.
   */
  unconfirmed?: boolean
  reason: string
}

export interface CancelPlanResult {
  ok: boolean
  message: string
  runId?: string
  planId?: string
  status?: 'stopped'
}

/** Resolve contradictory provider flags using process outcome and the worker's explicit contract. */
export function judgeWorkerTerminalResult(result: HeadlessResult): WorkerTerminalJudgement {
  if (result.status === 'cancelled') {
    return {
      status: 'stopped',
      failureKind: 'cancelled',
      reason: 'Der Worker wurde durch den Stop-Mechanismus abgebrochen.'
    }
  }

  const infrastructureFailure =
    result.failureKind === 'provider-auth' ||
    result.failureKind === 'sandbox' ||
    result.failureKind === 'stalled'
  if (infrastructureFailure) {
    return {
      status: 'error',
      failureKind: 'infrastructure',
      reason: result.error?.trim() ||
        `Provider-Infrastruktur fehlgeschlagen (${result.failureKind}).`
    }
  }

  if (hasExplicitWorkerBlocker(result.result)) {
    return {
      status: 'error',
      failureKind: 'worker',
      reason: 'Der Worker meldete explizit ERGEBNIS: BLOCKER.'
    }
  }

  if (result.exitCode === 0 && hasExplicitWorkerSuccess(result.result)) {
    return {
      status: 'success',
      reason: 'Provider-Prozess endete mit Exit-Code 0 und expliziter ERGEBNIS: ERFOLG-Meldung.'
    }
  }

  if (result.status === 'succeeded' && !result.isError) {
    return { status: 'success', reason: 'Der Provider meldete einen erfolgreichen Worker-Abschluss.' }
  }
  if (result.status == null && !result.isError) {
    return { status: 'success', reason: 'Der kompatible Provider-Adapter meldete keinen Fehler.' }
  }

  if (result.exitCode === 0) {
    return {
      status: 'error',
      failureKind: 'worker',
      unconfirmed: true,
      reason: 'Der Provider meldete einen Fehler trotz Exit-Code 0 und ohne expliziten ' +
        'Ergebnisvertrag; die Abnahme-Gates entscheiden über die Übernahme.'
    }
  }

  const exitDetail = result.exitCode == null ? '' : ` (Exit-Code ${result.exitCode})`
  return {
    status: 'error',
    failureKind: 'worker',
    reason: result.error?.trim() ||
      `Der Provider bewertete den Worker-Abschluss als fehlgeschlagen${exitDetail}.`
  }
}


/** Numeric sequence of a `<prefix><base36>` runtime id, or null for foreign ids. */
function parseSequenceId(id: string, prefix: string): number | null {
  if (!id.startsWith(prefix)) return null
  const raw = id.slice(prefix.length)
  if (!/^[0-9a-z]+$/.test(raw)) return null
  const value = Number.parseInt(raw, 36)
  return Number.isFinite(value) ? value : null
}

function initialReliability(): OrchestratorReliabilityMetrics {
  return {
    dispatchAttempts: 0,
    preflightPassed: 0,
    preflightFailed: 0,
    infrastructureFailures: 0,
    automaticRecoveries: 0,
    needsWorkTasks: 0,
    rescuedNeedsWorkCommits: 0,
    adoptedRecoveryArtifacts: 0,
    completedPlans: 0,
    preventedFalseSuccesses: 0,
    lastSnapshotAt: Date.now(),
    maxRunningStatusAgeMs: 0,
    failuresByProviderAndPlatform: {}
  }
}

export class OrchestratorEngine extends EventEmitter {
  readonly engineId: string
  private planSeq = 0
  private planRunSeq = 0
  private goal: OrchestratorGoal | null = null
  private activity: OrchestratorActivity | undefined
  private readonly tasks = new Map<string, OrcaTask>()
  private readonly preparedChanges = new Map<string, PreparedTaskChange>()
  private readonly taskResults = new Map<string, string>()
  private readonly taskRuns = new Map<string, Promise<string>>()
  private readonly planRuns = new Map<string, Promise<ExecutionPlanResult>>()
  private readonly planRunResults = new Map<string, PlanRunStatusSnapshot>()
  private readonly planRunPlanIds = new Map<string, string>()
  private readonly cancelledPlanRuns = new Set<string>()
  private readonly reliability = initialReliability()
  private goalStartedAt?: number
  private taskSeq = 0
  private benchSeq = 0
  private lastRetro: RunRetro | undefined
  /** Live coordination board written by subagents (post_finding). */
  private readonly findingsBoard: SubagentFinding[] = []
  private findingSeq = 0
  private multiAgentSeq = 0
  private readonly multiAgentRuns = new Map<string, MultiAgentRuntime>()
  private supportSeq = 0
  private readonly subagentRequests = new Map<string, SubagentSupportRequest>()
  private readonly supportWaiters = new Map<string, Set<(request: SubagentSupportRequest) => void>>()
  private persistTimer: ReturnType<typeof setTimeout> | undefined
  private lastPersistedAt = 0
  private pendingSnapshot: OrchestratorSnapshot | undefined
  private readonly benchmarkRuns = new Map<
    string,
    { benchmarkId: string; title: string; prompt: string; taskIds: string[]; startedAt: number }
  >()
  private pendingPlan: PendingPlanReview | undefined
  private pendingPlanResolve: ((approved: boolean) => void) | undefined
  /** Review-gate state per planId, so approvals are awaitable instead of polled. */
  private readonly planReviewStates = new Map<string, Extract<PlanReviewState, 'pending' | 'approved' | 'rejected'>>()
  private readonly planReviewWaiters = new Map<string, Promise<boolean>>()
  private pendingPublication: ApprovalItem | undefined
  private publicationInFlight = false
  private readonly pendingPermissions = new Map<string, PermissionRequest>()
  private budgetCaps: RemoteBudgetCaps = {}
  private readonly pausedTasks = new Set<string>()
  private readonly resumeRequestedTasks = new Set<string>()
  private readonly resumeTaskWaiters = new Map<string, () => void>()
  private readonly forcedFallbackRoles = new Map<string, string>()
  private readonly fallbackInFlight = new Set<string>()
  private readonly dispatchRecords = new Map<string, DispatchRecord>()
  private firstPlanApproved = true
  /** Per-role capacity limiter — count = max parallel subagents of that role. */
  private boundProfile: WorkspaceProfile | undefined
  private readonly workspaceSessionId: string | undefined

  constructor(options: { profile?: WorkspaceProfile; workspaceSessionId?: string } = {}) {
    super()
    this.engineId = `engine-${options.workspaceSessionId ?? randomUUID()}`
    this.boundProfile = options.profile
      ? { ...options.profile, agents: options.profile.agents.map((slot) => ({ ...slot })) }
      : undefined
    this.workspaceSessionId = options.workspaceSessionId
    permissionBroker.on('pending', this.onPermissionPending)
    permissionBroker.on('resolved', this.onPermissionResolved)
    const restored = getSetting<OrchestratorSnapshot>(this.persistenceKey())
    this.budgetCaps = restored?.budget?.caps ? { ...restored.budget.caps } : {}
    if (restored?.reliability) {
      Object.assign(this.reliability, restored.reliability, {
        failuresByProviderAndPlatform: { ...restored.reliability.failuresByProviderAndPlatform }
      })
    }
    if (!restored || !Array.isArray(restored.tasks)) return
    this.lastRetro = restored.lastRetro
    this.activity = restored.activity
      ? {
          phase: 'idle',
          summary: 'Der vorherige Lauf ist beendet oder wurde durch den App-Neustart unterbrochen.',
          details: [],
          nextStep: 'Ein neues Ziel aufnehmen oder den letzten Stand prüfen.',
          updatedAt: Date.now()
        }
      : undefined
    this.goal = restored.goal
      ? { ...restored.goal, active: false }
      : null
    for (const task of restored.tasks) {
      if (!task || typeof task.id !== 'string') continue
      const interrupted = ['queued', 'running', 'waiting', 'paused'].includes(task.status)
      this.tasks.set(task.id, {
        ...task,
        status: interrupted ? 'stopped' : task.status,
        note: interrupted ? 'Durch App-Neustart unterbrochen.' : task.note,
        finishedAt: interrupted ? Date.now() : task.finishedAt
      })
      // Resume the id sequence past restored tasks; otherwise the next
      // dispatch would silently overwrite restored history under the same id.
      const taskSeq = parseSequenceId(task.id, 't-')
      if (taskSeq != null) this.taskSeq = Math.max(this.taskSeq, taskSeq)
    }
    if (Array.isArray(restored.findings)) {
      for (const finding of restored.findings) {
        if (!finding || typeof finding.id !== 'string' || typeof finding.title !== 'string') continue
        this.findingsBoard.push({ ...finding, files: finding.files ? [...finding.files] : undefined })
        const findingSeq = parseSequenceId(finding.id, 'finding-')
        if (findingSeq != null) this.findingSeq = Math.max(this.findingSeq, findingSeq)
      }
    }
  }

  private readonly limiters = new Map<string, Semaphore>()

  private readonly onPermissionPending = (request: PermissionRequest): void => {
    if (request.engineId !== this.engineId) return
    this.pendingPermissions.set(request.id, request)
    const task = request.taskId ? this.tasks.get(request.taskId) : undefined
    if (task?.status === 'running') {
      task.status = 'waiting'
      task.lastAction = `Wartet auf Tool-Freigabe: ${request.tool}`
    }
    this.push()
  }

  private readonly onPermissionResolved = (request: PermissionRequest): void => {
    if (!this.pendingPermissions.delete(request.id)) return
    const task = request.taskId ? this.tasks.get(request.taskId) : undefined
    if (task?.status === 'waiting') {
      task.status = 'running'
      task.lastAction = 'Tool-Entscheidung erhalten; Worker setzt fort'
    }
    this.push()
  }

  private budgetSnapshot(): RemoteBudgetSnapshot {
    let tokens = 0
    let costUsd = 0
    const measuredTasks = [...this.tasks.values()].filter((task) => task.provider || task.usage)
    for (const task of measuredTasks) {
      tokens += (task.usage?.tokensIn ?? 0) + (task.usage?.tokensOut ?? 0)
      costUsd += task.usage?.costUsd ?? 0
    }
    const exceededBy: Array<'tokens' | 'cost'> = []
    if (this.budgetCaps.maxTokens != null && tokens >= this.budgetCaps.maxTokens) exceededBy.push('tokens')
    if (this.budgetCaps.maxCostUsd != null && costUsd >= this.budgetCaps.maxCostUsd) exceededBy.push('cost')
    const reported = measuredTasks.filter((task) => task.usage && Object.values(task.usage).some((value) => value != null))
    return {
      tokens,
      costUsd,
      caps: { ...this.budgetCaps },
      exceeded: exceededBy.length > 0,
      tasksReported: reported.length,
      tasksTotal: measuredTasks.length,
      tokenDataComplete: measuredTasks.length > 0 && measuredTasks.every((task) =>
        task.usage?.tokensIn != null || task.usage?.tokensOut != null
      ),
      costDataComplete: measuredTasks.length > 0 && measuredTasks.every((task) => task.usage?.costUsd != null),
      exceededBy
    }
  }

  private integrationSnapshot(): IntegrationCenterSnapshot {
    const items = [...this.tasks.values()]
      .filter((task) => task.autoPrStatus != null && (
        task.autoPrStatus !== 'skipped' || task.commit != null || task.prUrl != null
      ))
      .map((task) => ({
        taskId: task.id,
        title: task.title,
        status: task.autoPrStatus!,
        commit: task.commit,
        branch: task.branch,
        prUrl: task.prUrl,
        remoteCiStatus: task.remoteCiStatus,
        remoteCiUrl: task.remoteCiUrl,
        remoteCiSummary: task.remoteCiSummary,
        findingCount: task.findings?.length ?? 0
      }))
    let status: IntegrationCenterSnapshot['status'] = 'idle'
    if (this.publicationInFlight) status = 'publishing'
    else if (this.pendingPublication) status = 'awaiting-approval'
    else if (items.some((item) =>
      item.status === 'blocked' ||
      item.remoteCiStatus === 'failed' ||
      item.remoteCiStatus === 'cancelled' ||
      item.remoteCiStatus === 'timed-out' ||
      item.remoteCiStatus === 'unavailable'
    )) status = 'blocked'
    else if (items.some((item) => item.status === 'prepared')) status = 'prepared'
    else if (items.some((item) => item.status === 'published')) status = 'published'
    return { status, pendingPublicationId: this.pendingPublication?.id, items }
  }

  snapshot(): OrchestratorSnapshot {
    const profile = this.activeProfile()
    const tasks = [...this.tasks.values()].sort((a, b) => a.createdAt - b.createdAt)
    const agents = typeof agentManager.list === 'function' ? agentManager.list() : []
    const now = Date.now()
    const runningAges = tasks
      .filter((task) => task.status === 'running')
      .map((task) => now - (task.lastHeartbeatAt ?? task.createdAt))
    this.reliability.maxRunningStatusAgeMs = Math.max(
      this.reliability.maxRunningStatusAgeMs,
      ...runningAges,
      0
    )
    const warmInteractiveAgents = agents.filter((agent) =>
      agent.mode === 'interactive' && agent.kind === 'sub' && agent.status !== 'stopped' &&
      agent.status !== 'error' && (!profile?.id || agent.profileId === profile.id)
    ).length
    return {
      profileId: this.boundProfile?.id,
      workspaceSessionId: this.workspaceSessionId,
      engineId: this.engineId,
      plannerMode: profile?.planner.mode,
      goal: this.goal,
      activity: this.activity ? { ...this.activity, details: [...this.activity.details] } : undefined,
      tasks,
      reliability: {
        ...this.reliability,
        failuresByProviderAndPlatform: { ...this.reliability.failuresByProviderAndPlatform }
      },
      capacity: {
        warmInteractiveAgents,
        maxTaskParallelism: profile?.planner.maxParallel ?? 1,
        configuredRoleCapacity: this.slotsWithRoles().reduce((sum, entry) => sum + entry.slot.count, 0),
        activeTasks: tasks.filter((task) => task.status === 'running').length,
        waitingTasks: tasks.filter((task) => task.status === 'queued' || task.status === 'waiting' || task.status === 'paused').length
      },
      pendingPlan: this.pendingPlan,
      pendingApprovals: this.pendingPublication ? [this.pendingPublication] : [],
      pendingPermissions: [...this.pendingPermissions.values()].map((request) => ({ ...request })),
      budget: this.budgetSnapshot(),
      integration: this.integrationSnapshot(),
      lastRetro: this.lastRetro,
      findings: this.listTaskFindings(),
      multiAgentRuns: this.listMultiAgentRuns(),
      subagentRequests: this.listSubagentSupportRequests()
    }
  }

  private push(): void {
    this.reliability.lastSnapshotAt = Date.now()
    const snapshot = this.snapshot()
    // Lifecycle events arrive up to once per second per running worker; a full
    // synchronous config write for each would stall the main process. The live
    // event stays immediate, only the disk write is throttled (with a trailing
    // write, so the persisted state is never older than the throttle window).
    this.persistSnapshotThrottled(snapshot)
    this.emit('snapshot', snapshot)
  }

  private persistSnapshotThrottled(snapshot: OrchestratorSnapshot): void {
    this.pendingSnapshot = snapshot
    if (this.persistTimer) return
    const wait = this.lastPersistedAt + SNAPSHOT_PERSIST_MIN_INTERVAL_MS - Date.now()
    if (wait <= 0) {
      this.persistPendingSnapshot()
      return
    }
    this.persistTimer = setTimeout(() => {
      this.persistTimer = undefined
      this.persistPendingSnapshot()
    }, wait)
    this.persistTimer.unref?.()
  }

  private persistPendingSnapshot(): void {
    const snapshot = this.pendingSnapshot
    this.pendingSnapshot = undefined
    if (!snapshot) return
    this.lastPersistedAt = Date.now()
    try {
      setSetting(this.persistenceKey(), snapshot)
    } catch (error) {
      console.warn('[Orchestrator] snapshot persistence failed', error)
    }
  }

  private setActivityState(
    phase: OrchestratorActivityPhase,
    summary: string,
    details: string[] = [],
    nextStep?: string
  ): void {
    const clean = (value: string, max: number): string =>
      value.replace(/\s+/g, ' ').trim().slice(0, max)
    this.activity = {
      phase,
      summary: clean(summary, 280) || 'Aktualisiert den Orchestrierungsstatus.',
      details: details.map((detail) => clean(detail, 220)).filter(Boolean).slice(0, 4),
      nextStep: nextStep ? clean(nextStep, 220) : undefined,
      updatedAt: Date.now()
    }
  }

  reportActivity(input: {
    phase: OrchestratorActivityPhase
    summary: string
    details?: string[]
    nextStep?: string
  }): OrchestratorActivity {
    this.setActivityState(input.phase, input.summary, input.details, input.nextStep)
    this.push()
    return { ...this.activity!, details: [...this.activity!.details] }
  }

  private syncActivityFromTasks(): void {
    const tasks = [...this.tasks.values()]
    const running = tasks.filter((task) => task.status === 'running')
    const queued = tasks.filter((task) => task.status === 'queued' || task.status === 'waiting' || task.status === 'paused')
    const active = [...running, ...queued]
    const details = active.slice(0, 4).map((task) => {
      const owner = task.agentName ?? task.role
      const action = task.lastAction ?? task.phase ?? task.status
      return `${owner}: ${task.title} · ${action}`
    })
    const integration = running.find((task) => task.role === 'integrator')
    if (integration) {
      this.setActivityState(
        'integrating',
        integration.lastAction || 'Führt die verifizierten Subagent-Ergebnisse zusammen.',
        details,
        'Integration und Qualitätsprüfungen abschließen.'
      )
      return
    }
    if (running.length > 0 || queued.length > 0) {
      this.setActivityState(
        running.length > 0 ? 'monitoring' : 'delegating',
        `Überwacht ${running.length} laufende Subagents; ${queued.length} Aufgabe(n) warten auf Kapazität.`,
        details,
        'Statuswechsel, Blocker und Ergebnisse prüfen.'
      )
      return
    }
    const recent = tasks.sort((a, b) => b.createdAt - a.createdAt).slice(0, 4)
    const failed = recent.filter((task) => task.status === 'error' || task.status === 'needs-work')
    this.setActivityState(
      failed.length > 0 ? 'blocked' : 'summarizing',
      failed.length > 0
        ? `Prüft ${failed.length} fehlgeschlagene Aufgabe(n) und ordnet die Blocker ein.`
        : 'Alle gestarteten Subagents sind fertig; Ergebnisse werden für den Nutzer zusammengefasst.',
      recent.map((task) => `${task.agentName ?? task.role}: ${task.title} · ${task.lastAction ?? task.status}`),
      failed.length > 0 ? 'Fehlerursachen und sichere nächste Schritte nennen.' : 'Ergebnis, Prüfungen und nächste Schritte berichten.'
    )
  }

  reset(): void {
    this.pendingPlanResolve?.(false)
    this.pendingPlanResolve = undefined
    this.pendingPlan = undefined
    this.pendingPublication = undefined
    this.publicationInFlight = false
    for (const permissionId of [...this.pendingPermissions.keys()]) {
      permissionBroker.resolve(permissionId, 'deny', 'engine-reset')
    }
    this.pendingPermissions.clear()
    for (const resume of this.resumeTaskWaiters.values()) resume()
    this.resumeTaskWaiters.clear()
    this.pausedTasks.clear()
    this.resumeRequestedTasks.clear()
    this.forcedFallbackRoles.clear()
    this.fallbackInFlight.clear()
    this.dispatchRecords.clear()
    this.firstPlanApproved = true
    this.goal = null
    this.activity = undefined
    this.tasks.clear()
    this.limiters.clear()
    this.preparedChanges.clear()
    this.taskResults.clear()
    this.taskRuns.clear()
    this.planRuns.clear()
    this.planRunResults.clear()
    this.planRunPlanIds.clear()
    this.cancelledPlanRuns.clear()
    this.benchmarkRuns.clear()
    for (const run of this.multiAgentRuns.values()) {
      run.resolve({ action: 'rejected', message: 'Multiagent-Lauf durch Engine-Reset beendet.' })
    }
    this.multiAgentRuns.clear()
    for (const request of this.subagentRequests.values()) {
      if (request.status === 'pending') {
        request.status = 'stopped'
        request.response = 'Orchestrator wurde zurückgesetzt.'
        request.respondedAt = Date.now()
        this.notifySupportWaiters(request)
      }
    }
    this.subagentRequests.clear()
    this.supportWaiters.clear()
    this.findingsBoard.length = 0
    this.lastRetro = undefined
    this.push()
    // A reset must survive an immediate app restart; skip the throttle window.
    if (this.persistTimer) {
      clearTimeout(this.persistTimer)
      this.persistTimer = undefined
    }
    this.persistPendingSnapshot()
  }

  dispose(): void {
    this.reset()
    permissionBroker.off('pending', this.onPermissionPending)
    permissionBroker.off('resolved', this.onPermissionResolved)
    this.removeAllListeners()
  }

  resolvePermission(permissionId: string, allow: boolean): boolean {
    if (!this.pendingPermissions.has(permissionId)) return false
    return permissionBroker.resolve(permissionId, allow ? 'allow' : 'deny')
  }

  async requestToolPermission(taskId: string, tool: string): Promise<boolean> {
    const task = this.tasks.get(taskId)
    if (
      !task || task.status !== 'running' || !task.agentId || !task.provider || task.yolo
    ) return false
    const decision = await permissionBroker.requestDecision({
      provider: task.provider,
      agentId: task.agentId,
      taskId,
      profileId: this.boundProfile?.id,
      workspaceSessionId: this.workspaceSessionId,
      engineId: this.engineId,
      yolo: Boolean(task.yolo)
    }, tool)
    return decision === 'allow'
  }

  setBudgetCaps(caps: RemoteBudgetCaps): RemoteBudgetSnapshot {
    this.budgetCaps = {
      maxTokens: caps.maxTokens,
      maxCostUsd: caps.maxCostUsd
    }
    const budget = this.budgetSnapshot()
    if (budget.exceeded) {
      for (const task of this.tasks.values()) {
        if (task.status === 'running') void this.pauseTask(task.id)
      }
    }
    this.push()
    return budget
  }

  async pauseTask(taskId: string): Promise<boolean> {
    const task = this.tasks.get(taskId)
    if (!task || !['queued', 'running', 'paused'].includes(task.status)) return false
    if (this.pausedTasks.has(taskId)) {
      this.resumeRequestedTasks.delete(taskId)
      task.status = 'paused'
      task.lastAction = 'Sicher pausiert'
      this.push()
      return true
    }
    this.pausedTasks.add(taskId)
    task.status = 'paused'
    task.lastAction = 'Sicher pausiert; Worker wird angehalten'
    task.note = 'Remote-Pause aktiv. Fortsetzung startet kontrolliert aus dem Orca-Worktree.'
    task.finishedAt = undefined
    this.push()
    if (task.agentId) await agentManager.kill(task.agentId)
    return true
  }

  resumeTask(taskId: string): boolean {
    const task = this.tasks.get(taskId)
    if (!task || !this.pausedTasks.has(taskId)) return false
    task.status = 'queued'
    task.lastAction = 'Fortsetzung wird vorbereitet'
    task.note = undefined
    const resume = this.resumeTaskWaiters.get(taskId)
    if (resume) {
      this.resumeTaskWaiters.delete(taskId)
      this.pausedTasks.delete(taskId)
      resume()
    } else {
      // A process shutdown may still be settling. Remember the decision so the
      // continuation cannot accidentally be judged as a cancelled final task.
      this.resumeRequestedTasks.add(taskId)
    }
    this.push()
    return true
  }

  /**
   * Switch a rate-limited task to a different configured provider. The caller
   * supplies only the task id; Orca chooses the provider and keeps all prompt,
   * path and stdin details inside the engine boundary.
   */
  async fallbackTask(taskId: string): Promise<boolean> {
    const task = this.tasks.get(taskId)
    if (!task?.provider || this.fallbackInFlight.has(taskId)) return false
    const agentLimit = task.agentId
      ? agentManager.list().find((agent) => agent.id === task.agentId)?.limitWarning
      : undefined
    const limitText = [
      task.note,
      task.judgeReason,
      task.blocker?.summary,
      this.taskResults.get(taskId)
    ].filter(Boolean).join(' ')
    if (!agentLimit && !detectLimit(task.provider, limitText)) return false
    const fallback = this.listSubagents()
      .filter((agent) => agent.available && agent.provider !== task.provider && agent.role !== task.role)
      .sort((left, right) => (left.busy / left.capacity) - (right.busy / right.capacity))[0]
    if (!fallback) return false

    if (task.status === 'running' || task.status === 'queued' || task.status === 'paused') {
      this.forcedFallbackRoles.set(taskId, fallback.role)
      const paused = await this.pauseTask(taskId)
      if (!paused) {
        this.forcedFallbackRoles.delete(taskId)
        return false
      }
      return this.resumeTask(taskId)
    }

    const record = this.dispatchRecords.get(taskId)
    if (!record || (task.status !== 'error' && task.status !== 'needs-work')) return false
    this.fallbackInFlight.add(taskId)
    task.status = 'queued'
    task.finishedAt = undefined
    task.lastAction = `Provider-Limit: sichere Fortsetzung mit ${fallback.provider}`
    task.note = 'Orca startet einen Ersatz-Worker aus dem gesicherten Recovery-Artefakt.'
    this.reliability.automaticRecoveries += 1
    this.push()
    void this.dispatch(
      fallback.role,
      record.prompt,
      record.title,
      {
        ...record.options,
        taskId,
        recoveryWorktree: task.recoveryArtifact?.worktree
      }
    ).finally(() => this.fallbackInFlight.delete(taskId))
    return true
  }

  private resumedRole(taskId: string, currentRole: string): string {
    const forced = this.forcedFallbackRoles.get(taskId)
    if (forced) this.forcedFallbackRoles.delete(taskId)
    return forced ?? currentRole
  }

  private waitForTaskResume(taskId: string): Promise<void> {
    if (!this.pausedTasks.has(taskId)) return Promise.resolve()
    if (this.resumeRequestedTasks.delete(taskId)) {
      this.pausedTasks.delete(taskId)
      return Promise.resolve()
    }
    return new Promise<void>((resolve) => this.resumeTaskWaiters.set(taskId, resolve))
  }

  replanPending(input: { removeTaskIds: string[]; maxParallel?: number }): boolean {
    const pending = this.pendingPlan
    if (!pending) return false
    const removed = new Set(input.removeTaskIds)
    const tasks = pending.plan.tasks.filter((task) => !removed.has(task.id))
    if (tasks.length === 0) return false
    if (tasks.some((task) =>
      task.dependsOn.some((id) => removed.has(id)) ||
      (task.advisoryDependsOn ?? []).some((id) => removed.has(id))
    )) return false
    const maxParallel = input.maxParallel ?? pending.plan.maxParallel
    if (!Number.isInteger(maxParallel) || maxParallel < 1 || maxParallel > 32) return false
    this.pendingPlan = {
      ...pending,
      plan: { ...pending.plan, maxParallel, tasks }
    }
    this.setActivityState(
      'awaiting-review',
      `Plan-Vorschau wurde restriktiv angepasst und wartet erneut auf Freigabe.`,
      [`${tasks.length} Aufgabe(n), maximal ${maxParallel} parallel.`]
    )
    this.push()
    return true
  }

  private persistenceKey(): string {
    if (this.boundProfile?.id && this.workspaceSessionId) {
      return `orchestratorSnapshot:${this.boundProfile.id}:${this.workspaceSessionId}`
    }
    if (this.boundProfile?.id) return `orchestratorSnapshot:${this.boundProfile.id}`
    return 'orchestratorSnapshot'
  }

  reviewPlan(approved: boolean): boolean {
    const resolve = this.pendingPlanResolve
    if (!resolve) return false
    const pending = this.pendingPlan
    this.pendingPlanResolve = undefined
    this.pendingPlan = undefined
    this.firstPlanApproved = approved && pending?.rejected !== true
    if (pending) {
      this.planReviewStates.set(pending.planId, approved ? 'approved' : 'rejected')
      // Aktives Signal statt Polling: await_plan_approval und externe
      // Konsumenten erfahren die Panel-Entscheidung sofort.
      this.emit('plan-review', { planId: pending.planId, approved })
    }
    this.setActivityState(
      approved ? 'delegating' : 'blocked',
      approved
        ? 'Der freigegebene Plan wird jetzt an die vorgesehenen Subagents verteilt.'
        : 'Der vorgeschlagene Plan wurde abgelehnt; es werden keine Subagents gestartet.',
      [],
      approved ? 'Subagents starten und ihre ersten Statusmeldungen prüfen.' : 'Auf ein angepasstes Ziel oder einen neuen Plan warten.'
    )
    this.push()
    resolve(approved)
    return true
  }

  /**
   * Switch only this live workspace session to a planner mode. Switching to
   * 'auto' keeps a plan already waiting at the review gate pending for an
   * explicit decision. Switching away from 'auto' (back to 'review'/'manual')
   * changes how the next plan is handled and never cancels work already running.
   */
  setPlannerMode(mode: WorkspaceProfile['planner']['mode']): boolean {
    const profile = this.activeProfile()
    if (!profile) return false
    this.boundProfile = {
      ...profile,
      agents: profile.agents.map((slot) => ({ ...slot })),
      planner: { ...profile.planner, mode }
    }
    this.push()
    return true
  }

  /**
   * Promote only this live workspace session to automatic plan execution.
   * A plan already waiting at the review gate is approved as part of the switch.
   */
  enableAutoMode(): boolean {
    return this.setPlannerMode('auto')
  }

  private requestPlanReview(review: PendingPlanReview): Promise<boolean> {
    if (this.pendingPlanResolve) throw new Error('Ein anderer Plan wartet bereits auf Review.')
    const waiter = new Promise<boolean>((resolve) => {
      this.pendingPlan = review
      this.pendingPlanResolve = resolve
      this.setActivityState(
        'awaiting-review',
        review.rejected
          ? 'Die Plan-Validierung ersetzte den strukturierten Plan durch einen konservativen Ersatz-Task; die Freigabe entscheidet über die Ausführung.'
          : `Der Plan mit ${review.plan.tasks.length} Aufgabe(n) ist erstellt und wartet auf Freigabe.`,
        [
          ...review.validationIssues.slice(0, 2).map((issue) => `Validierung: ${issue.message}`),
          ...review.plan.tasks.slice(0, 4).map((task) => `${task.role}: ${task.title}`)
        ].slice(0, 4),
        'Nach Freigabe die DAG-Aufgaben gemäß Abhängigkeiten starten.'
      )
      this.push()
    })
    this.planReviewStates.set(review.planId, 'pending')
    this.planReviewWaiters.set(review.planId, waiter)
    void waiter.finally(() => this.planReviewWaiters.delete(review.planId))
    return waiter
  }

  /**
   * Block until the review gate of a plan run is decided, instead of polling
   * get_plan_status/list_tasks for the approval side effect. Returns
   * immediately for plans that never required a review.
   */
  async awaitPlanApproval(runId: string, timeoutMs?: number): Promise<AwaitPlanApprovalResult> {
    const stored = this.planRunResults.get(runId)
    if (!stored) return { done: false, stillRunning: false, reason: 'unknown', runId }
    const planId = stored.planId ?? this.planRunPlanIds.get(runId)
    const state = planId ? this.planReviewStates.get(planId) : undefined
    const snapshot = (): PlanRunStatusSnapshot => this.getPlanRunStatus(runId) ?? stored
    if (state !== 'pending') {
      return { done: true, stillRunning: false, reviewState: state ?? 'not-required', plan: snapshot() }
    }
    const waiter = planId ? this.planReviewWaiters.get(planId) : undefined
    if (!waiter) {
      return { done: true, stillRunning: false, reviewState: state, plan: snapshot() }
    }
    const outcome = await this.raceWithTimeout(
      waiter.then(() => undefined, () => undefined),
      this.clampAwaitTimeout(timeoutMs)
    )
    if (outcome === 'settled') {
      const decided = (planId ? this.planReviewStates.get(planId) : undefined) ?? 'not-required'
      return { done: true, stillRunning: false, reviewState: decided, plan: snapshot() }
    }
    return { done: false, stillRunning: true, reason: 'timeout', reviewState: 'pending', plan: snapshot() }
  }

  private limiter(role: string, capacity: number): Semaphore {
    let sem = this.limiters.get(role)
    if (!sem) {
      sem = new Semaphore(Math.max(1, capacity))
      this.limiters.set(role, sem)
    } else {
      sem.setLimit(Math.max(1, capacity))
    }
    return sem
  }

  /** Called when an orchestrator agent starts, to mark the goal active. */
  activate(profileOverride?: WorkspaceProfile): void {
    const profile = profileOverride ?? this.boundProfile ?? getProfile(getActiveProfileId())
    this.boundProfile = profile
      ? { ...profile, agents: profile.agents.map((slot) => ({ ...slot })) }
      : undefined
    if (!this.goal) this.goal = { id: 'goal', title: 'Orchestrator aktiv', active: true }
    else this.goal.active = true
    this.setActivityState(
      'idle',
      'Der Orchestrator ist bereit und wartet im Terminal auf ein konkretes Ziel.',
      [],
      'Ziel aufnehmen, Teamkapazität prüfen und eine sinnvolle Aufgabenverteilung entwerfen.'
    )
    this.push()
  }

  setGoal(title: string): SetGoalResult {
    const retroReminder = this.pendingRetroReminder()
    this.goalStartedAt = Date.now()
    this.firstPlanApproved = false
    this.goal = { id: `epic-${Date.now().toString(36)}`, title, active: true }
    this.setActivityState(
      'planning',
      'Analysiert das Ziel und entscheidet, welche Teilaufgaben delegiert werden sollen.',
      [`Ziel: ${title}`],
      'Verfügbare Subagent-Rollen prüfen und den Ausführungsplan erstellen.'
    )
    this.push()
    return retroReminder ? { retroReminder } : {}
  }

  private activeProfile(): WorkspaceProfile | undefined {
    return this.boundProfile ?? getProfile(getActiveProfileId())
  }

  /**
   * Assign every profile slot a stable role before filtering dispatchability.
   * This keeps duplicate-role suffixes identical to the already-started team,
   * even when an earlier slot with the same role is not orchestrated.
   */
  private slotsWithRoles(): Array<{ slot: AgentSlot; role: string }> {
    const enabled = normalizeProviderEnabled(getSetting('providerEnabled'))
    const disabledModels = normalizeDisabledModels(getSetting('disabledModels'))
    const configured = agentSlotsWithRoles(this.activeProfile()?.agents ?? []).filter(
      ({ slot }) =>
        slot.orchestrated &&
        enabled[slot.provider] &&
        !isModelDisabled(disabledModels, slot.provider, resolveModel(slot.provider, slot))
    )
    if (configured.length > 0) return configured

    const fallbackProvider = (['codex', 'claude', 'copilot', 'cursor', 'ollama'] as const)
      .find((provider) => enabled[provider])
    if (!fallbackProvider) return []
    return agentSlotsWithRoles([{
      role: 'worker',
      provider: fallbackProvider,
      model: '',
      count: 1,
      orchestrated: true,
      yolo: false,
      strengths: [],
      weaknesses: []
    }])
  }

  listSubagents(): SubagentDescriptor[] {
    const profile = this.activeProfile()
    return this.slotsWithRoles().map(({ slot, role }) => {
      const capabilities = agentSlotCapabilities(slot)
      const workingDir = slot.workingDir || profile?.workingDir || homedir()
      const preflight = typeof agentManager.latestPreflight === 'function'
        ? agentManager.latestPreflight(slot.provider, workingDir)
        : undefined
      const model = resolveSlotModel(slot.provider, slot)
      // Knowledge accumulated from earlier retros/benchmarks; never allowed to
      // break routing when the store is unavailable.
      let learned: { strengths: string[]; weaknesses: string[] } = { strengths: [], weaknesses: [] }
      try {
        learned = learningsForModel(slot.provider, model)
      } catch (error) {
        console.warn('[Orchestrator] Modell-Lernwissen nicht lesbar', error)
      }
      return {
        role,
        provider: slot.provider,
        model,
        capacity: slot.count,
        busy: this.limiters.get(role)?.inUse ?? 0,
        strengths: capabilities.strengths,
        weaknesses: capabilities.weaknesses,
        learnedStrengths: learned.strengths,
        learnedWeaknesses: learned.weaknesses,
        available: preflight?.status !== 'failed',
        preflight
      }
    })
  }

  async listSubagentsWithHealth(): Promise<SubagentDescriptor[]> {
    const profile = this.activeProfile()
    if (typeof agentManager.preflightSlot === 'function') {
      await Promise.allSettled(this.slotsWithRoles().map(async ({ slot }) => {
        const workingDir = slot.workingDir || profile?.workingDir || homedir()
        const cached = typeof agentManager.latestPreflight === 'function'
          ? agentManager.latestPreflight(slot.provider, workingDir)
          : undefined
        if (cached && Date.now() - cached.completedAt < 60_000) return
        await agentManager.preflightSlot({
          provider: slot.provider,
          workingDir,
          engineId: this.engineId,
          workspaceSessionId: this.workspaceSessionId
        })
      }))
    }
    return this.listSubagents()
  }

  private nextTaskId(): string {
    this.taskSeq += 1
    return `t-${this.taskSeq.toString(36)}`
  }

  private pickSlot(role: string): { slot: AgentSlot; role: string } {
    const entries = this.slotsWithRoles()
    const q = role.trim().toLowerCase()
    const selected =
      entries.find((entry) => entry.role === q) ??
      entries.find((entry) => entry.slot.provider === q) ??
      entries.find((entry) => entry.role.includes(q) || q.includes(entry.role)) ??
      entries[0]
    if (!selected) {
      throw new Error('Kein global aktivierter Worker ist fuer dieses Profil verfuegbar.')
    }
    return selected
  }

  private multiAgentSnapshot(run: MultiAgentRuntime): MultiAgentRunSnapshot {
    return {
      id: run.id, parentTaskId: run.parentTaskId, title: run.title, role: run.role,
      status: run.status, candidateTaskIds: [...run.candidateTaskIds],
      winnerTaskId: run.winnerTaskId, feedback: run.feedback,
      startedAt: run.startedAt, decidedAt: run.decidedAt
    }
  }

  listMultiAgentRuns(): MultiAgentRunSnapshot[] {
    return [...this.multiAgentRuns.values()]
      .sort((a, b) => a.startedAt - b.startedAt)
      .map((run) => this.multiAgentSnapshot(run))
  }

  private startMultiAgentCandidate(
    run: MultiAgentRuntime,
    input: { prompt: string; recoveryWorktree?: string }
  ): string {
    run.nextCandidate += 1
    const candidate = run.nextCandidate
    const taskId = `${run.parentTaskId}-m${candidate}`
    run.candidateTaskIds.push(taskId)
    const candidatePrompt = [
      input.prompt,
      '',
      `Multiagent-Kandidat ${candidate} in Gruppe ${run.id}: Entwickle eine eigenständige Lösung.`,
      'Kommuniziere Zwischenstände früh, teile Entscheidungen/Blocker und frage den Orchestrator direkt, wenn Unterstützung oder eine Richtungsentscheidung nötig ist.',
      'Änderungen anderer Kandidaten dürfen nicht übernommen oder zusammengeführt werden.'
    ].join('\n')
    const work = this.dispatch(run.role, candidatePrompt, `${run.title} · Kandidat ${candidate}`, {
      ...run.options,
      taskId,
      recoveryWorktree: input.recoveryWorktree,
      multiAgentRunId: run.id,
      multiAgentParentTaskId: run.parentTaskId,
      multiAgentCandidate: candidate
    })
      .then((result) => {
        this.taskResults.set(taskId, result)
        return result
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error)
        this.taskResults.set(taskId, message)
        return message
      })
    this.taskRuns.set(taskId, work)
    void work.finally(() => {
      this.taskRuns.delete(taskId)
      const current = this.multiAgentRuns.get(run.id)
      if (!current || current.status === 'accepted' || current.status === 'rejected') return
      const complete = current.candidateTaskIds.every((id) => {
        const task = this.tasks.get(id)
        return task ? isTerminalTaskStatus(task.status) : false
      })
      if (!complete) return
      current.status = 'awaiting-review'
      const parent = this.tasks.get(current.parentTaskId)
      if (parent) {
        parent.status = 'waiting'
        parent.phase = 'security-review'
        parent.lastAction = `${current.candidateTaskIds.length} Kandidaten warten auf Orchestrator-Review`
        parent.lastHeartbeatAt = Date.now()
      }
      this.setActivityState(
        'reviewing',
        `Vergleicht ${current.candidateTaskIds.length} Kandidaten für „${current.title}“.`,
        ['Diffs, Tests, Findings und Worker-Ergebnisse bewerten.'],
        'Einen Kandidaten übernehmen, gezielt überarbeiten lassen oder die Gruppe verwerfen.'
      )
      this.push()
    })
    return taskId
  }

  private async dispatchMultiAgent(
    role: string,
    slotRole: string,
    prompt: string,
    title: string | undefined,
    options: DispatchOptions,
    candidateCount: number
  ): Promise<string> {
    const { slot } = this.pickSlot(role)
    const profile = this.activeProfile()
    const parentTaskId = options.taskId ?? this.nextTaskId()
    const runId = `multi-${++this.multiAgentSeq}`
    const taskTitle = title?.trim() || prompt.split('\n')[0].slice(0, 60)
    const parent: OrcaTask = this.tasks.get(parentTaskId) ?? {
      id: parentTaskId, title: taskTitle, role: slotRole, status: 'running', createdAt: Date.now()
    }
    Object.assign(parent, {
      title: taskTitle, role: slotRole, provider: slot.provider, model: resolveSlotModel(slot.provider, slot),
      status: 'running' as const, phase: 'working' as const,
      lastAction: `Startet ${candidateCount} parallele Kandidaten`, lastHeartbeatAt: Date.now(),
      yolo: slot.yolo || (profile?.yoloDefault ?? false),
      dependsOn: options.dependsOn, advisoryDependsOn: options.advisoryDependsOn,
      conflictKeys: options.conflictKeys, expectedFiles: options.expectedFiles,
      planId: options.planId, planTaskId: options.planTaskId, engineId: this.engineId,
      criticality: options.criticality ?? 'required', ownership: options.ownership ?? 'feature',
      multiAgentRunId: runId, agentId: undefined, agentName: undefined, finishedAt: undefined
    })
    this.tasks.set(parentTaskId, parent)
    if (!this.dispatchRecords.has(parentTaskId)) {
      this.dispatchRecords.set(parentTaskId, { role, prompt, title, options: { ...options } })
    }

    let resolve!: (outcome: MultiAgentOutcome) => void
    const decided = new Promise<MultiAgentOutcome>((done) => { resolve = done })
    const run: MultiAgentRuntime = {
      id: runId, parentTaskId, title: taskTitle, role: slotRole, status: 'running',
      candidateTaskIds: [], startedAt: Date.now(), prompt, options: { ...options },
      nextCandidate: 0, resolve
    }
    this.multiAgentRuns.set(runId, run)
    this.setActivityState(
      'delegating',
      `Startet ${candidateCount} konkurrierende Kandidaten für „${taskTitle}“.`,
      [`Rolle ${slotRole}; jeder Kandidat arbeitet in einem isolierten Worktree.`],
      'Live-Findings beobachten und Kandidaten anschließend reviewen.'
    )
    for (let index = 0; index < candidateCount; index += 1) {
      this.startMultiAgentCandidate(run, { prompt })
    }
    this.push()
    const outcome = await decided
    return outcome.message
  }

  async reviewMultiAgentRun(input: {
    runId: string
    action: 'accept' | 'revise' | 'reject'
    candidateTaskId?: string
    feedback: string
  }): Promise<MultiAgentRunSnapshot> {
    const run = this.multiAgentRuns.get(input.runId)
    if (!run) throw new Error('Multiagent-Lauf nicht gefunden.')
    if (run.status === 'accepted' || run.status === 'rejected') return this.multiAgentSnapshot(run)
    const feedback = input.feedback.replace(/\s+/g, ' ').trim().slice(0, 2_000)
    if (!feedback) throw new Error('Die Orchestrator-Entscheidung benötigt eine konkrete Begründung.')
    const selected = input.candidateTaskId ? this.tasks.get(input.candidateTaskId) : undefined
    const selectedBelongs = Boolean(selected && run.candidateTaskIds.includes(selected.id))

    if (input.action !== 'reject' && !selectedBelongs) {
      throw new Error('Für Übernahme oder Überarbeitung muss ein Kandidat aus dieser Gruppe gewählt werden.')
    }
    if (input.action !== 'reject' && selected && !isTerminalTaskStatus(selected.status)) {
      throw new Error('Der gewählte Kandidat ist noch nicht fertig und kann noch nicht bewertet werden.')
    }

    const stopAlternatives = async (keepTaskId?: string): Promise<void> => {
      const shouldStop = input.action !== 'accept' || (this.activeProfile()?.multiAgent.stopLosers ?? true)
      if (!shouldStop) return
      await Promise.all(run.candidateTaskIds.map(async (taskId) => {
        if (taskId === keepTaskId) return
        const task = this.tasks.get(taskId)
        if (task?.agentId && !isTerminalTaskStatus(task.status)) await agentManager.kill(task.agentId)
      }))
    }

    if (input.action === 'revise') {
      await stopAlternatives(selected!.id)
      for (const taskId of run.candidateTaskIds) {
        this.preparedChanges.delete(taskId)
        const candidate = this.tasks.get(taskId)
        if (candidate) candidate.autoPrStatus = undefined
      }
      run.status = 'running'
      run.feedback = feedback
      const parent = this.tasks.get(run.parentTaskId)!
      parent.status = 'running'
      parent.phase = 'working'
      parent.lastAction = `Überarbeitung für ${selected!.agentName ?? selected!.id} angefordert`
      parent.lastHeartbeatAt = Date.now()
      const previous = this.taskResults.get(selected!.id) ?? selected!.note ?? '(kein Ergebnistext)'
      this.startMultiAgentCandidate(run, {
        prompt: `${run.prompt}\n\nOrchestrator-Review: ${feedback}\n\nVorheriges Ergebnis:\n${previous}`,
        recoveryWorktree: selected!.worktree
      })
      this.push()
      return this.multiAgentSnapshot(run)
    }

    await stopAlternatives(input.action === 'accept' ? selected?.id : undefined)
    const parent = this.tasks.get(run.parentTaskId)!
    const selectedPrepared = selected ? this.preparedChanges.get(selected.id) : undefined
    const selectedAutoPrStatus = selected?.autoPrStatus
    for (const taskId of run.candidateTaskIds) {
      this.preparedChanges.delete(taskId)
      const candidate = this.tasks.get(taskId)
      if (candidate) candidate.autoPrStatus = undefined
    }

    if (input.action === 'accept') {
      if (selected!.status !== 'success' && selected!.status !== 'needs-work') {
        throw new Error('Nur ein erfolgreicher oder als nacharbeitsfähig bewerteter Kandidat kann übernommen werden.')
      }
      if (selectedPrepared) this.preparedChanges.set(parent.id, selectedPrepared)
      Object.assign(parent, {
        agentId: selected!.agentId, agentName: selected!.agentName, provider: selected!.provider,
        model: selected!.model, status: selected!.status, phase: selected!.phase,
        progress: selected!.progress, lastHeartbeatAt: Date.now(), usage: selected!.usage,
        note: feedback, judgeReason: feedback, worktree: selected!.worktree, branch: selected!.branch,
        commit: selected!.commit, completion: selected!.completion, findings: selected!.findings,
        blocker: selected!.blocker, failureKind: selected!.failureKind, preflight: selected!.preflight,
        attempts: selected!.attempts, autoPrStatus: selectedAutoPrStatus, finishedAt: Date.now(),
        lastAction: `Kandidat ${selected!.agentName ?? selected!.id} vom Orchestrator übernommen`
      })
      run.status = 'accepted'
      run.winnerTaskId = selected!.id
      run.feedback = feedback
      run.decidedAt = Date.now()
      const message = `Multiagent-Gewinner ${selected!.agentName ?? selected!.id}: ${feedback}\n\n${this.taskResults.get(selected!.id) ?? selected!.note ?? ''}`
      run.resolve({ action: 'accepted', message })
    } else {
      Object.assign(parent, {
        status: 'stopped' as const, phase: 'completed' as const, failureKind: 'cancelled' as const,
        note: feedback, judgeReason: feedback, lastAction: 'Alle Multiagent-Kandidaten verworfen',
        finishedAt: Date.now(), lastHeartbeatAt: Date.now()
      })
      run.status = 'rejected'
      run.feedback = feedback
      run.decidedAt = Date.now()
      run.resolve({ action: 'rejected', message: `Multiagent-Gruppe verworfen: ${feedback}` })
    }
    this.syncActivityFromTasks()
    this.push()
    return this.multiAgentSnapshot(run)
  }

  /**
   * Dispatch a subtask to a subagent and wait for its result.
   * Returns the subagent's final message (fed back to the orchestrator).
   * Respects the slot's capacity: extra tasks show as "queued" until a slot frees.
   */
  async dispatch(
    role: string,
    prompt: string,
    title?: string,
    options: DispatchOptions = {}
  ): Promise<string> {
    const { slot, role: slotRole } = this.pickSlot(role)
    const profile = this.activeProfile()
    if (!options.multiAgentRunId && profile?.multiAgent?.enabled && slot.count > 1) {
      return this.dispatchMultiAgent(role, slotRole, prompt, title, options, Math.min(slot.count, 16))
    }
    const taskId = options.taskId ?? this.nextTaskId()
    if (!this.dispatchRecords.has(taskId)) {
      this.dispatchRecords.set(taskId, {
        role,
        prompt,
        title,
        options: {
          ...options,
          dependsOn: options.dependsOn ? [...options.dependsOn] : undefined,
          advisoryDependsOn: options.advisoryDependsOn ? [...options.advisoryDependsOn] : undefined,
          conflictKeys: options.conflictKeys ? [...options.conflictKeys] : undefined,
          expectedFiles: options.expectedFiles ? [...options.expectedFiles] : undefined
        }
      })
    }
    const yolo = slot.yolo || (profile?.yoloDefault ?? false)

    const task: OrcaTask = this.tasks.get(taskId) ?? {
      id: taskId,
      title: title?.trim() || prompt.split('\n')[0].slice(0, 60),
      role: slotRole,
      status: 'queued',
      createdAt: Date.now()
    }
    Object.assign(task, {
      title: title?.trim() || task.title,
      role: slotRole,
      provider: slot.provider,
      model: resolveSlotModel(slot.provider, slot),
      status: 'queued' as const,
      phase: 'queued' as const,
      lastAction: 'Wartet auf freie Kapazität',
      lastHeartbeatAt: Date.now(),
      yolo,
      dependsOn: options.dependsOn,
      advisoryDependsOn: options.advisoryDependsOn,
      conflictKeys: options.conflictKeys,
      planId: options.planId,
      engineId: this.engineId,
      expectedFiles: options.expectedFiles,
      criticality: options.criticality ?? task.criticality ?? 'required',
      ownership: options.ownership ?? task.ownership ?? 'feature',
      planTaskId: options.planTaskId ?? task.planTaskId,
      multiAgentRunId: options.multiAgentRunId,
      multiAgentParentTaskId: options.multiAgentParentTaskId,
      multiAgentCandidate: options.multiAgentCandidate,
      agentId: undefined,
      agentName: undefined,
      blocker: undefined,
      findings: undefined,
      failureKind: undefined,
      judgeReason: undefined,
      finishedAt: undefined
    })
    this.tasks.set(taskId, task)
    this.setActivityState(
      'delegating',
      `Übergibt „${task.title}“ an die Rolle ${slotRole}.`,
      [`Task ${taskId} wurde angelegt und wartet auf einen freien Worker.`],
      'Worker-Start bestätigen und anschließend Fortschritt überwachen.'
    )
    this.push()

    const sem = this.limiter(slotRole, slot.count)
    await sem.acquire()
    // The slot models a running worker PROCESS. Gates, commit contract and
    // remote CI happen after the process exits, so the slot is handed back as
    // soon as the worker terminates instead of blocking queued tasks for the
    // whole acceptance pipeline.
    let slotReleased = false
    const releaseSlot = (): void => {
      if (slotReleased) return
      slotReleased = true
      sem.release()
    }
    if (this.pausedTasks.has(taskId)) {
      task.status = 'paused'
      task.lastAction = 'Pausiert vor Worker-Start'
      releaseSlot()
      await this.waitForTaskResume(taskId)
      return this.dispatch(this.resumedRole(taskId, role), prompt, title, { ...options, taskId })
    }
    task.status = 'running'
    task.phase = 'preflight'
    task.lastAction = 'Pane-Preflight läuft'
    task.lastHeartbeatAt = Date.now()
    this.syncActivityFromTasks()
    this.push()

    const securityChecklist = securityChecklistForFiles(options.expectedFiles ?? [])
    const orcaSubTools = subagentOrcaToolsAvailable(slot.provider)
    const executionContract = [
      'Orca-Ausführungsvertrag:',
      '- Bearbeite nur die beauftragte Fachaufgabe und die erwarteten Dateien.',
      '- Führe relevante Tests, Typecheck und Lint aus.',
      '- Führe kein git add, commit, cherry-pick oder push aus; Orcas Main-Prozess sichert Änderungen zentral.',
      '- Bei Infrastrukturblockern antworte strukturiert und knapp: Blocker, Alternativen, geplante Dateien, Schnittstellen.',
      '- Ergebnisvertrag am Ende: (1) geänderte Dateien, (2) Tests mit grün/gesamt, (3) Typecheck-/Lint-Status, (4) Integrationshinweise.',
      '- Schließe exakt mit ERGEBNIS: ERFOLG oder ERGEBNIS: BLOCKER samt konkreter Begründung.',
      '- Automatisch injizierte Security-Negativfälle: securityGate.ts bewertet nur hinzugefügte Diff-Zeilen.',
      '- Neue Zeilen mit process.env, Bearer, Authorization, Secret-Literalen, writeFileSync, appendFileSync, createWriteStream, rm oder child_process-Aufrufen brauchen passende Missbrauchs-/Injection-/Leak-Negativtests in Testdateien.',
      ...(orcaSubTools
        ? [
            '- Live-Status: Melde wichtige Phasenwechsel und Zwischenstände knapp über das MCP-Tool report_progress (Server orca-sub).',
            '- Team-Board: Teile Schnittstellen, Entscheidungen und Blocker, die parallele Tasks betreffen, über post_finding; prüfe mit list_findings die Einträge anderer Subagents, bevor du gemeinsame Schnittstellen festlegst.',
            '- Direkte Hilfe: Wenn eine Richtungsentscheidung, Freigabe oder Unterstützung fehlt, nutze ask_orchestrator und warte mit await_orchestrator_response auf die konkrete Antwort.'
          ]
        : []),
      ...providerExecutionGuidance(slot.provider, yolo).map((item) => `- ${item}`),
      ...platformExecutionGuidance().map((item) => `- ${item}`),
      ...securityChecklist.map((item) => `- Security-Pflicht: ${item}`)
    ].join('\n')
    const taskPrompt = `${prompt}\n\n${executionContract}`
    const subSystemPrompt =
      'Du bist ein namentlich gekennzeichneter Subagent in Orca-Strator, beauftragt vom Orchestrator. ' +
      'Erledige die Aufgabe eigenständig und fasse das Ergebnis am Ende knapp zusammen. ' +
      'Git-Schreiboperationen werden ausschließlich von Orcas Main-Prozess ausgeführt.'

    const attemptNumber = options.attempt ?? (task.attempts?.length ?? 0) + 1
    let activeAttempt: TaskAttemptSnapshot | undefined
    this.reliability.dispatchAttempts += 1
    let lastLifecyclePush = 0
    const rememberAction = (): void => this.rememberTaskAction(task)
    const onLifecycleEvent = (event: import('@main/agents/headless').HeadlessLifecycleEvent): void => {
      task.lastHeartbeatAt = event.timestamp
      if (event.type === 'phase') task.lastAction = `Worker-Phase: ${event.phase}`
      if (event.type === 'heartbeat') task.lastAction = `Worker aktiv · ${Math.round(event.idleMs / 1000)}s ohne Ausgabe`
      if (event.type === 'progress') task.lastAction = `Provider-Fortschritt: ${event.providerEvent}`
      if (event.type === 'usage') {
        task.usage = {
          costUsd: event.costUsd,
          tokensIn: event.tokensIn,
          tokensOut: event.tokensOut,
          steps: event.steps
        }
        if (this.budgetSnapshot().exceeded) void this.pauseTask(taskId)
      }
      if (event.type === 'output') {
        const clean = stripAnsi(event.chunk).replace(/\s+/g, ' ').trim()
        if (clean) task.lastAction = clean.slice(-RESULT_PREVIEW)
        if (/\b(test|vitest|typecheck|lint|pytest|cargo test)\b/i.test(clean)) task.phase = 'testing'
        else if (/\b(git commit|committ(?:ing|ed)?)\b/i.test(clean)) task.phase = 'committing'
        else if (task.phase === 'starting') task.phase = 'working'
      }
      // Heartbeat idle counters churn every tick; only real activity belongs
      // in the "what did the worker actually do" history.
      if (event.type === 'phase' || event.type === 'progress' || event.type === 'output') {
        rememberAction()
      }
      const force = event.type === 'heartbeat' || event.type === 'phase' || event.type === 'finished'
      if (force || event.timestamp - lastLifecyclePush >= 1_000) {
        lastLifecyclePush = event.timestamp
        this.push()
      }
    }

    try {
      const { info, done, baseCommit } = await agentManager.runTask({
        provider: slot.provider,
        model: slot.model,
        modelPreset: slot.modelPreset,
        role: slotRole,
        taskId,
        prompt: taskPrompt,
        systemPrompt: subSystemPrompt,
        yolo,
        workingDir: slot.workingDir || profile?.workingDir,
        profileId: profile?.id,
        workspaceSessionId: this.workspaceSessionId,
        recoveryWorktree: options.recoveryWorktree,
        engineId: this.engineId
      }, { onEvent: onLifecycleEvent, heartbeatIntervalMs: 45_000 })
      task.agentId = info.id
      task.agentName = info.name
      task.preflight = info.preflight
      if (info.preflight?.status === 'passed') this.reliability.preflightPassed += 1
      activeAttempt = {
        attempt: attemptNumber,
        agentId: info.id,
        agentName: info.name,
        provider: info.provider as OrcaTask['provider'],
        model: info.model,
        status: 'running',
        startedAt: Date.now()
      }
      task.attempts = [...(task.attempts ?? []), activeAttempt]
      task.phase = 'working'
      task.lastAction = 'Worker arbeitet'
      task.lastHeartbeatAt = Date.now()
      this.syncActivityFromTasks()
      this.push()

      const result = await done
      releaseSlot()
      if (this.pausedTasks.has(taskId)) {
        const recoveryArtifact = await captureTaskRecoveryArtifact({
          worktree: info.worktree,
          baseCommit
        })
        task.recoveryArtifact = recoveryArtifact
        task.status = 'paused'
        task.lastAction = 'Pausiert; Teilarbeit sicher für Fortsetzung gehalten'
        task.note = recoveryArtifact
          ? `${recoveryArtifact.changedFiles.length} Datei(en) im Orca-Worktree gesichert.`
          : 'Pausiert, bevor persistierbare Änderungen entstanden sind.'
        task.finishedAt = undefined
        if (activeAttempt) {
          activeAttempt.status = 'stopped'
          activeAttempt.failureKind = 'cancelled'
          activeAttempt.finishedAt = Date.now()
          activeAttempt.note = 'Durch sichere Remote-Pause unterbrochen.'
        }
        this.push()
        await this.waitForTaskResume(taskId)
        return this.dispatch(this.resumedRole(taskId, role), prompt, title, {
          ...options,
          taskId,
          recoveryWorktree: recoveryArtifact?.worktree
        })
      }
      if (
        result.costUsd != null ||
        result.tokensIn != null ||
        result.tokensOut != null ||
        result.steps != null
      ) {
        task.usage = {
          costUsd: result.costUsd,
          tokensIn: result.tokensIn,
          tokensOut: result.tokensOut,
          steps: result.steps
        }
      }
      const judgement = judgeWorkerTerminalResult(result)
      const wasCancelled = judgement.status === 'stopped'
      const workerError = judgement.status === 'error'
      const infrastructureFailure = judgement.failureKind === 'infrastructure'
      task.status = judgement.status
      task.failureKind = judgement.failureKind
      task.judgeReason = judgement.reason
      task.progress = task.status === 'success' ? 100 : undefined
      task.phase = task.status === 'success' ? 'completed' : task.phase
      task.lastAction = wasCancelled
        ? 'Manuell gestoppt'
        : infrastructureFailure
          ? 'Provider-Infrastruktur fehlgeschlagen' : workerError ? 'Worker fehlgeschlagen' : 'Worker abgeschlossen'
      if (activeAttempt) {
        activeAttempt.status = task.status
        activeAttempt.failureKind = task.failureKind
        activeAttempt.finishedAt = Date.now()
        activeAttempt.note = result.result.replace(/\s+/g, ' ').trim().slice(0, RESULT_PREVIEW)
      }
      task.lastHeartbeatAt = Date.now()
      task.finishedAt = Date.now()
      const preview = result.result.replace(/\s+/g, ' ').trim().slice(0, RESULT_PREVIEW)
      task.note = workerError ? judgement.reason : preview
      task.worktree = info.worktree
      if (infrastructureFailure) {
        task.note = preview || 'Provider-Infrastruktur fehlgeschlagen'
        task.blocker = {
          kind: 'infrastructure',
          code: `provider-${result.failureKind}`,
          summary: task.note,
          details: [result.result.trim().slice(0, 1_000)].filter(Boolean),
          recoverable: true
        }
        this.reliability.infrastructureFailures += 1
        const metricKey = `${slot.provider}:${process.platform}`
        this.reliability.failuresByProviderAndPlatform[metricKey] =
          (this.reliability.failuresByProviderAndPlatform[metricKey] ?? 0) + 1
      }
      if (workerError) {
        task.recoveryArtifact = await captureTaskRecoveryArtifact({
          worktree: info.worktree,
          baseCommit
        })
        if (task.recoveryArtifact) {
          task.lastAction = 'Teilarbeit als Recovery-Artefakt gesichert'
          task.note = `${task.note} · ${task.recoveryArtifact.changedFiles.length} Datei(en) quarantined`
        }
      } else {
        task.recoveryArtifact = undefined
      }
      const autoPr = profile?.autoPr
      const attemptCount = options.attempt ?? 1
      const finalAttempt = attemptCount >= (options.maxAttempts ?? attemptCount)
      // Exit-Code 0 ohne Ergebnisvertrag bei gesetztem Provider-Fehlerflag:
      // widersprüchliche Signale, die Abnahme-Gates entscheiden statt des Flags.
      const gateArbitration =
        workerError && judgement.unconfirmed === true && Boolean(autoPr) && Boolean(info.worktree)
      // Letzter Versuch mit quarantänisierter Teilarbeit: bestehen alle Gates,
      // wird das Artefakt als Commit übernommen statt verworfen.
      const recoveryAdoption =
        workerError && !gateArbitration && finalAttempt &&
        Boolean(task.recoveryArtifact?.changedFiles.length) && Boolean(autoPr) && Boolean(info.worktree)
      // Ohne Worktree gibt es nichts abzunehmen: bei deaktiviertem Auto-PR wird
      // die Abnahme übersprungen statt als 'unavailable' zu blocken — der
      // Remote-Selftest scheiterte hieran 5× in Folge und vergiftete die
      // Learnings mit einem fabrizierten Modellfehler.
      const acceptanceApplicable = Boolean(info.worktree) || autoPr?.mode !== 'off'
      if (autoPr && acceptanceApplicable &&
        (task.status === 'success' || gateArbitration || recoveryAdoption)) {
        task.phase = 'security-review'
        task.lastAction = workerError
          ? 'Abnahme-Gates prüfen das unbestätigte Worker-Ergebnis'
          : 'Abnahme, Security und Commit-Vertrag laufen'
        task.lastHeartbeatAt = Date.now()
        this.setActivityState(
          'reviewing',
          `Prüft das Ergebnis von ${task.agentName ?? task.role} vor der Integration.`,
          [`${task.title}: ${task.lastAction}`],
          'Commit-Vertrag und Security-Gate auswerten.'
        )
        this.push()
        const prepared = await prepareTaskChange({
          config: autoPr,
          commitOnly: true,
          baseCommit,
          taskId,
          title: task.title,
          worktree: info.worktree
        })
        task.autoPrStatus = autoPr.mode === 'off' ? 'skipped' : prepared.status
        task.branch = prepared.branch
        if (prepared.result === 'committed' && prepared.change) {
          task.commit = prepared.change.commit
          task.completion = { kind: 'commit', commit: prepared.change.commit }
          if (prepared.findings?.length) {
            task.findings = [...(task.findings ?? []), ...prepared.findings]
          }
          if (gateArbitration) {
            task.status = 'success'
            task.failureKind = undefined
            task.progress = 100
            task.phase = 'completed'
            task.judgeReason =
              'Abnahme-Gates und Commit-Vertrag bestätigten das Ergebnis trotz fehlendem Ergebnisvertrag (Exit-Code 0).'
            task.note = prepared.message
            task.lastAction = 'Gates bestätigten das Worker-Ergebnis'
            task.recoveryArtifact = undefined
            if (activeAttempt) {
              activeAttempt.status = 'success'
              activeAttempt.failureKind = undefined
              activeAttempt.note = task.judgeReason
            }
          } else if (recoveryAdoption) {
            task.status = 'needs-work'
            task.progress = undefined
            task.findings = [...(task.findings ?? []), {
              gate: 'commit',
              code: 'recovered-artifact-adopted',
              message: 'Quarantänisierte Teilarbeit bestand alle Gates und wurde als Commit ' +
                prepared.change.commit.slice(0, 8) + ' übernommen.'
            }]
            task.judgeReason = `${judgement.reason} Die Teilarbeit bestand alle Gates und wurde übernommen.`
            task.note = `${task.note} · Recovery-Artefakt nach grünen Gates übernommen`
            task.lastAction = 'Recovery-Artefakt nach grünen Gates übernommen'
            task.recoveryArtifact = undefined
            this.reliability.adoptedRecoveryArtifacts += 1
            this.reliability.needsWorkTasks += 1
            if (activeAttempt) {
              activeAttempt.status = 'needs-work'
              activeAttempt.note = task.judgeReason
            }
          }
          if (this.reliability.timeToFirstUsefulCommitMs == null && this.goalStartedAt) {
            this.reliability.timeToFirstUsefulCommitMs = Date.now() - this.goalStartedAt
          }
          if (autoPr.mode !== 'off' && task.status === 'success') {
            this.preparedChanges.set(taskId, prepared.change)
          }
        } else if (prepared.result === 'needs-work' && prepared.change) {
          task.status = 'needs-work'
          task.progress = undefined
          task.commit = prepared.change.commit
          task.completion = { kind: 'commit', commit: prepared.change.commit }
          task.findings = recoveryAdoption
            ? [...(prepared.findings ?? []), {
                gate: 'commit',
                code: 'recovered-artifact-adopted',
                message: 'Quarantänisierte Teilarbeit wurde als partieller Commit ' +
                  prepared.change.commit.slice(0, 8) + ' übernommen; Gates benötigen Nacharbeit.'
              }]
            : prepared.findings
          task.failureKind = 'gate'
          task.note = prepared.message
          task.judgeReason = prepared.message
          task.lastAction = 'Partieller Commit gesichert · Gates benötigen Nacharbeit'
          task.recoveryArtifact = undefined
          this.reliability.needsWorkTasks += 1
          this.reliability.rescuedNeedsWorkCommits += 1
          if (recoveryAdoption) this.reliability.adoptedRecoveryArtifacts += 1
          if (activeAttempt) {
            activeAttempt.status = 'needs-work'
            activeAttempt.failureKind = 'gate'
            activeAttempt.note = prepared.message
          }
        } else if (prepared.result === 'no-changes') {
          // Ein Worker-Fehler ohne jegliche Änderungen liefert keinen Beleg für
          // erledigte Arbeit; das Fehler-Urteil bleibt dann bestehen.
          if (!workerError) task.completion = { kind: 'no-changes' }
        } else if (!workerError) {
          task.status = 'error'
          // Fehlendes Gate-Tooling (eslint/prisma) ist ein Infrastruktur-, kein
          // Modellproblem — Retros werteten solche Läufe fälschlich als Modellfehler.
          task.failureKind = prepared.infrastructure ? 'infrastructure' : 'gate'
          task.progress = undefined
          task.note = (task.note || 'Worker fertig') + ' · Abnahme blockiert: ' + prepared.message
          task.judgeReason = prepared.infrastructure
            ? `Gate-Infrastruktur fehlgeschlagen (kein Modellfehler): ${prepared.message}`
            : `Commit-Vertrag oder Security-Gate fehlgeschlagen: ${prepared.message}`
          task.lastAction = prepared.infrastructure
            ? 'Gate-Infrastruktur fehlgeschlagen'
            : 'Commit-Vertrag oder Security-Gate fehlgeschlagen'
          if (prepared.infrastructure) this.reliability.infrastructureFailures += 1
          if (activeAttempt) {
            activeAttempt.status = 'error'
            activeAttempt.failureKind = task.failureKind
            activeAttempt.note = task.judgeReason
          }
        } else {
          task.note = `${task.note} · Abnahme der Teilarbeit blockiert: ${prepared.message}`
        }
        if (task.status === 'success' && autoPr.mode !== 'off' && !options.planId && prepared.change) {
          await this.publishPendingChanges()
        }
      }
      this.syncActivityFromTasks()
      this.push()

      if (wasCancelled) return `${info.name} (${slotRole}) stopped.`
      if (task.status === 'needs-work') {
        const findings = task.findings?.map((finding) => finding.message).join('; ') || 'Gate-Nacharbeit erforderlich'
        return `${info.name} (${slotRole}) needs-work. Partieller Commit: ${task.commit}. Findings: ${findings}`
      }
      if (task.status === 'error' && !workerError) {
        return `${info.name} (${slotRole}) scheiterte an der Abnahme: ${task.note}`
      }
      const completion = task.completion?.kind === 'commit'
        ? `\n\nVerifizierter Commit: ${task.completion.commit}`
        : task.completion?.kind === 'no-changes' ? '\n\nVerifizierter Status: keine Änderungen' : ''
      const recoveryArtifact = task.recoveryArtifact
      const recovery = recoveryArtifact
        ? `\n\nRecovery-Artefakt: ${recoveryArtifact.worktree}\nDateien: ${recoveryArtifact.changedFiles.join(', ')}`
        : ''
      return task.status === 'error'
        ? `${info.name} (${slotRole}) meldete einen Fehler. Ausgabe:\n${result.result}${recovery}`
        : `${info.name} (${slotRole}) meldet:\n${result.result || '(kein Textergebnis)'}${completion}`
    } catch (err) {
      task.status = 'error'
      task.failureKind = 'infrastructure'
      task.phase = task.phase ?? 'preflight'
      task.lastAction = err instanceof PanePreflightError ? 'Pane-Preflight fehlgeschlagen' : 'Dispatch fehlgeschlagen'
      task.lastHeartbeatAt = Date.now()
      task.note = err instanceof Error ? err.message : String(err)
      task.judgeReason = `Dispatch-Infrastruktur fehlgeschlagen: ${task.note}`
      task.finishedAt = Date.now()
      this.reliability.infrastructureFailures += 1
      const metricKey = `${slot.provider}:${process.platform}`
      this.reliability.failuresByProviderAndPlatform[metricKey] =
        (this.reliability.failuresByProviderAndPlatform[metricKey] ?? 0) + 1
      if (err instanceof PanePreflightError) {
        task.preflight = err.report
        task.blocker = err.blocker()
        task.findings = err.report.checks
          .filter((check) => check.status === 'failed')
          .map((check) => ({
            gate: 'preflight' as const,
            code: check.id,
            message: check.detail
          }))
        this.reliability.preflightFailed += 1
      }
      if (!activeAttempt) {
        activeAttempt = {
          attempt: attemptNumber,
          provider: slot.provider,
          model: resolveSlotModel(slot.provider, slot),
          status: 'error',
          startedAt: Date.now(),
          finishedAt: Date.now(),
          failureKind: 'infrastructure',
          note: task.note
        }
        task.attempts = [...(task.attempts ?? []), activeAttempt]
      } else {
        activeAttempt.status = 'error'
        activeAttempt.failureKind = 'infrastructure'
        activeAttempt.finishedAt = Date.now()
        activeAttempt.note = task.note
      }
      this.syncActivityFromTasks()
      this.push()
      return `Dispatch fehlgeschlagen: ${task.note}`
    } finally {
      releaseSlot()
    }
  }

  /** Keep a short, distinct history of what the worker actually did. */
  private rememberTaskAction(task: OrcaTask): void {
    const action = task.lastAction?.trim()
    if (!action || task.recentActions?.[0] === action) return
    task.recentActions = [
      action,
      ...(task.recentActions ?? []).filter((entry) => entry !== action)
    ].slice(0, 3)
  }

  /** Start one worker without holding the MCP request open. */
  dispatchAsync(role: string, prompt: string, title?: string): TaskStatusSnapshot {
    const taskId = this.nextTaskId()
    const run = this.dispatch(role, prompt, title, { taskId })
      .then((result) => { this.taskResults.set(taskId, result); return result })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error)
        this.taskResults.set(taskId, message)
        return message
      })
    this.taskRuns.set(taskId, run)
    void run.finally(() => this.taskRuns.delete(taskId))
    return this.getTaskStatus(taskId) ?? { taskId, status: 'queued' }
  }

  dispatchBatchAsync(items: Array<{ role: string; prompt: string; title?: string }>): TaskStatusSnapshot[] {
    return items.map((item) => this.dispatchAsync(item.role, item.prompt, item.title))
  }

  getTaskStatus(taskId: string): TaskStatusSnapshot | undefined {
    const task = this.tasks.get(taskId)
    if (!task) return undefined
    const result = this.taskResults.get(taskId)
    // dispatch() updates the DAG just before its Promise resolves. Keep polling
    // non-terminal until the async result map is populated, so callers never
    // observe success/error without the corresponding result payload.
    const status = result == null && this.taskRuns.has(taskId) &&
      (task.status === 'success' || task.status === 'needs-work' || task.status === 'error' || task.status === 'stopped')
      ? 'running'
      : task.status
    return {
      taskId,
      title: task.title,
      role: task.role,
      agentId: task.agentId,
      agentName: task.agentName,
      provider: task.provider,
      model: task.model,
      status,
      criticality: task.criticality,
      ownership: task.ownership,
      planTaskId: task.planTaskId,
      phase: task.phase,
      progress: task.progress,
      lastAction: task.lastAction,
      recentActions: task.recentActions ? [...task.recentActions] : undefined,
      lastHeartbeatAt: task.lastHeartbeatAt,
      usage: task.usage ? { ...task.usage } : undefined,
      completion: task.completion,
      findings: task.findings?.map((finding) => ({ ...finding, files: finding.files ? [...finding.files] : undefined })),
      blocker: task.blocker ? { ...task.blocker, details: [...task.blocker.details] } : undefined,
      failureKind: task.failureKind,
      preflight: task.preflight ? { ...task.preflight, checks: task.preflight.checks.map((check) => ({ ...check })) } : undefined,
      recoveryArtifact: task.recoveryArtifact
        ? {
            ...task.recoveryArtifact,
            changedFiles: [...task.recoveryArtifact.changedFiles]
          } : undefined,
      attempts: task.attempts?.map((attempt) => ({ ...attempt })),
      result: task.status === 'success' || task.status === 'needs-work' || task.status === 'stopped'
        ? result ?? task.note
        : undefined,
      error: task.status === 'error' ? result ?? task.note : undefined,
      note: task.note,
      judgeReason: task.judgeReason
    }
  }

  listTaskStatuses(): TaskStatusSnapshot[] {
    return [...this.tasks.keys()].map((id) => this.getTaskStatus(id)!).filter(Boolean)
  }

  private clampAwaitTimeout(timeoutMs?: number): number {
    if (typeof timeoutMs !== 'number' || Number.isNaN(timeoutMs)) return AWAIT_DEFAULT_TIMEOUT_MS
    return Math.min(AWAIT_MAX_TIMEOUT_MS, Math.max(AWAIT_MIN_TIMEOUT_MS, Math.floor(timeoutMs)))
  }

  /**
   * Race a settle-guarded promise against a bounded, self-cleaning timer.
   * `settle` MUST already swallow rejections (`.then(() => undefined, () => undefined)`),
   * so attaching this awaiter to a shared job future never triggers an
   * unhandled rejection and multiple concurrent awaiters stay safe.
   */
  private async raceWithTimeout(settle: Promise<unknown>, timeoutMs: number): Promise<'settled' | 'timeout'> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), timeoutMs)
      timer.unref?.()
    })
    try {
      return await Promise.race([settle.then(() => 'settled' as const), timeout])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  /**
   * Block until a task reaches a terminal status instead of polling
   * get_task_status. Returns immediately when the task is already terminal,
   * `unknown` when the id is not known, and `stillRunning` on the long-poll
   * timeout so the caller can cheaply re-await.
   */
  async awaitTask(taskId: string, timeoutMs?: number): Promise<AwaitTaskResult> {
    const current = this.getTaskStatus(taskId)
    if (!current) return { done: false, stillRunning: false, reason: 'unknown', taskId }
    if (isTerminalTaskStatus(current.status)) {
      return { done: true, stillRunning: false, task: current }
    }
    const future = this.taskRuns.get(taskId)
    if (!future) return { done: false, stillRunning: true, reason: 'timeout', task: current }
    const outcome = await this.raceWithTimeout(
      future.then(() => undefined, () => undefined),
      this.clampAwaitTimeout(timeoutMs)
    )
    const task = this.getTaskStatus(taskId) ?? current
    if (outcome === 'settled' && isTerminalTaskStatus(task.status)) {
      return { done: true, stillRunning: false, task }
    }
    return { done: false, stillRunning: true, reason: 'timeout', task }
  }

  /**
   * Block until ONE of several tasks becomes terminal, returning it plus the
   * still-open ids. Reuses the scheduler's wake-on-next-completion idiom
   * (Promise.race over the job futures). Unknown ids are reported, not fatal.
   */
  async awaitAnyTask(taskIds: string[], timeoutMs?: number): Promise<AwaitAnyResult> {
    const known = taskIds.filter((id) => this.tasks.has(id))
    const unknownTaskIds = taskIds.filter((id) => !this.tasks.has(id))
    if (known.length === 0) {
      return { done: false, stillRunning: false, reason: 'unknown', unknownTaskIds }
    }
    const snapshotOf = (ids: string[]): TaskStatusSnapshot[] =>
      ids.map((id) => this.getTaskStatus(id)).filter((t): t is TaskStatusSnapshot => Boolean(t))
    const firstTerminal = (): TaskStatusSnapshot | undefined =>
      snapshotOf(known).find((t) => isTerminalTaskStatus(t.status))

    const alreadyDone = firstTerminal()
    if (alreadyDone) {
      return { done: true, stillRunning: false, task: alreadyDone, pending: known.filter((id) => id !== alreadyDone.taskId) }
    }
    const futures = known
      .map((id) => this.taskRuns.get(id))
      .filter((f): f is Promise<string> => Boolean(f))
      .map((f) => f.then(() => undefined, () => undefined))
    if (futures.length === 0) {
      return { done: false, stillRunning: true, reason: 'timeout', tasks: snapshotOf(known) }
    }
    const outcome = await this.raceWithTimeout(Promise.race(futures), this.clampAwaitTimeout(timeoutMs))
    if (outcome === 'settled') {
      const done = firstTerminal()
      if (done) {
        return { done: true, stillRunning: false, task: done, pending: known.filter((id) => id !== done.taskId) }
      }
    }
    return { done: false, stillRunning: true, reason: 'timeout', tasks: snapshotOf(known) }
  }

  /**
   * Block until a plan run reaches a terminal status instead of polling
   * get_plan_status. A plan still awaiting user review stays `stillRunning`
   * until it is approved. `stillRunning` on timeout signals a cheap re-await.
   */
  async awaitPlan(runId: string, timeoutMs?: number): Promise<AwaitPlanResult> {
    const current = this.getPlanRunStatus(runId)
    if (!current) return { done: false, stillRunning: false, reason: 'unknown', runId }
    if (current.status !== 'running') return this.terminalAwaitResult(runId, current)
    const future = this.planRuns.get(runId)
    if (!future) return { done: false, stillRunning: true, reason: 'timeout', plan: current }
    // The planRuns future rethrows on failure; the settle-guard neutralizes it.
    const outcome = await this.raceWithTimeout(
      future.then(() => undefined, () => undefined),
      this.clampAwaitTimeout(timeoutMs)
    )
    const plan = this.getPlanRunStatus(runId) ?? current
    if (outcome === 'settled' && plan.status !== 'running') {
      return this.terminalAwaitResult(runId, plan)
    }
    return { done: false, stillRunning: true, reason: 'timeout', plan }
  }

  /**
   * Validate and execute a model-authored DAG. The scheduler enforces global
   * concurrency, role capacity, dependencies and conflict keys. A structured
   * plan that fails validation is never dropped silently: its conservative
   * fallback task always runs through the review gate, so the user sees the
   * validation issues and decides instead of the plan collapsing unnoticed.
   */
  async executePlan(input: unknown, runId?: string): Promise<ExecutionPlanResult> {
    return this.executePreparedPlan(this.prepareExecutionPlan(input), runId)
  }

  private prepareExecutionPlan(input: unknown): PreparedExecutionPlan {
    const profile = this.activeProfile()
    if (profile?.planner.mode === 'manual') {
      throw new Error('Auto-Planung ist für dieses Profil deaktiviert.')
    }
    const subagents = this.listSubagents()
    const availableSubagents = subagents.filter((agent) => agent.available)
    if (availableSubagents.length === 0) {
      throw new Error('Kein Subagent hat den Pane-Preflight bestanden.')
    }
    const defaultRole = availableSubagents[0]?.role ?? 'worker'
    const resolved = resolveExecutionPlan(
      input,
      defaultRole,
      undefined,
      availableSubagents.map((agent) => agent.role)
    )
    const configuredLimit = profile?.planner.maxParallel ?? resolved.plan.maxParallel
    const plan = { ...resolved.plan, maxParallel: Math.min(resolved.plan.maxParallel, configuredLimit) }
    return { profile, resolved, plan }
  }

  private nextPlanId(): string {
    this.planSeq += 1
    return `plan-${Date.now().toString(36)}-${this.planSeq.toString(36)}`
  }

  private async executePreparedPlan(
    prepared: PreparedExecutionPlan,
    runId?: string,
    providedPlanId?: string
  ): Promise<ExecutionPlanResult> {
    const { profile, resolved, plan } = prepared
    if (!this.goal) {
      this.goalStartedAt = Date.now()
      this.goal = { id: `epic-${Date.now().toString(36)}`, title: plan.goal, active: true }
    }
    const planId = providedPlanId ?? this.nextPlanId()
    if (runId) {
      this.planRunPlanIds.set(runId, planId)
      // Pin this run's goal so concurrent plans cannot rewrite each other's
      // reported goal through the shared engine-level goal.
      const stored = this.planRunResults.get(runId)
      if (stored) this.planRunResults.set(runId, { ...stored, goal: plan.goal, planId })
    }
    const runtimeIds = new Map(
      plan.tasks.map((task) => [task.id, `${planId}-${task.id}`])
    )
    const requiredDependencies = (task: ExecutionPlanTask): string[] => task.dependsOn
    const advisoryDependencies = (task: ExecutionPlanTask): string[] => task.advisoryDependsOn
    const allDependencies = (task: ExecutionPlanTask): string[] =>
      [...requiredDependencies(task), ...advisoryDependencies(task)]
    const requiresPlanReview = resolved.usedFallback || profile?.planner.mode === 'review' ||
      (profile?.planner.mode === 'auto' && !this.firstPlanApproved)

    // Materialize every node before review/dispatch. list_tasks and
    // get_plan_status can therefore never claim a plan is running with no children.
    for (const planned of plan.tasks) {
      const selected = this.pickSlot(planned.role)
      const runtimeId = runtimeIds.get(planned.id)!
      this.tasks.set(runtimeId, {
        id: runtimeId,
        planTaskId: planned.id,
        title: planned.title,
        role: selected.role,
        provider: selected.slot.provider,
        model: resolveSlotModel(selected.slot.provider, selected.slot),
        status: 'queued',
        phase: 'queued',
        criticality: planned.criticality,
        ownership: planned.ownership,
        note: planned.criticality === 'advisory' ? 'Advisory-Task' : undefined,
        lastAction: requiresPlanReview
          ? 'Wartet auf Planfreigabe'
          : 'Wartet auf Abhängigkeiten und Kapazität',
        lastHeartbeatAt: Date.now(),
        dependsOn: requiredDependencies(planned).map((id) => runtimeIds.get(id)!),
        advisoryDependsOn: advisoryDependencies(planned).map((id) => runtimeIds.get(id)!),
        conflictKeys: planned.conflictKeys,
        expectedFiles: planned.expectedFiles,
        planId,
        engineId: this.engineId,
        createdAt: Date.now()
      })
    }
    this.push()

    if (requiresPlanReview) {
      const approved = await this.requestPlanReview({
        planId,
        plan,
        usedFallback: resolved.usedFallback,
        rejected: resolved.rejected,
        validationIssues: resolved.issues
      })
      if (!approved) {
        const reason = 'Plan wurde im Review abgelehnt.'
        for (const planned of plan.tasks) {
          const runtimeTask = this.tasks.get(runtimeIds.get(planned.id)!)!
          Object.assign(runtimeTask, {
            status: 'stopped' as const,
            failureKind: 'cancelled' as const,
            note: reason,
            lastAction: reason,
            finishedAt: Date.now()
          })
        }
        this.push()
        return {
          planId,
          status: 'stopped',
          usedFallback: resolved.usedFallback,
          rejected: resolved.rejected,
          validationIssues: resolved.issues,
          tasks: plan.tasks.map((task) => ({
            id: task.id,
            status: 'stopped',
            criticality: task.criticality,
            result: reason
          }))
        }
      }
    }

    for (const planned of plan.tasks) {
      const runtimeTask = this.tasks.get(runtimeIds.get(planned.id)!)
      if (runtimeTask) runtimeTask.lastAction = 'Wartet auf Abhängigkeiten und Kapazität'
    }
    this.setActivityState(
      'delegating',
      `Startet den Ausführungsplan mit ${plan.tasks.length} Aufgabe(n) und maximal ${plan.maxParallel} parallel.`,
      plan.tasks.slice(0, 4).map((task) => `${task.role}: ${task.title}`),
      'Subagents gemäß harten und advisory Abhängigkeiten starten und laufend überwachen.'
    )
    this.push()

    const pending = new Map(plan.tasks.map((task) => [task.id, task]))
    const active = new Map<string, Promise<void>>()
    const activeConflicts = new Set<string>()
    const results = new Map<string, ExecutionPlanTaskResult>()
    const isCancelled = (): boolean => Boolean(runId && this.cancelledPlanRuns.has(runId))

    const stopTask = (task: ExecutionPlanTask, reason: string): void => {
      const runtimeId = runtimeIds.get(task.id)!
      const stopped = this.tasks.get(runtimeId)!
      Object.assign(stopped, {
        status: 'stopped' as const,
        failureKind: isCancelled() ? 'cancelled' as const : 'worker' as const,
        note: reason,
        lastAction: reason,
        finishedAt: Date.now()
      })
      results.set(task.id, {
        id: task.id,
        status: 'stopped',
        criticality: task.criticality,
        result: reason
      })
      this.taskResults.set(runtimeId, reason)
      pending.delete(task.id)
      this.syncActivityFromTasks()
      this.push()
    }

    const startTask = (task: ExecutionPlanTask): void => {
      pending.delete(task.id)
      for (const key of task.conflictKeys) activeConflicts.add(key)
      const runtimeId = runtimeIds.get(task.id)!
      const dependencyContext = allDependencies(task)
        .map((id) => {
          const dependency = results.get(id)
          return dependency
            ? `# ${id} [${dependency.status}]\n${dependency.result.slice(0, MAX_DEPENDENCY_CONTEXT_CHARS)}`
            : undefined
        })
        .filter(Boolean)
        .join('\n\n--- dependency ---\n\n')
      const taskPrompt = dependencyContext
        ? `${task.prompt}\n\nDependency results (use available commits/findings; advisory failures do not block):\n${dependencyContext}`
        : task.prompt
      const running = (async (): Promise<void> => {
        const maxRetries = profile?.planner.maxRetries ?? 1
        const maxRateLimitRetries = Math.max(maxRetries, 1)
        const attemptedRoles = new Set<string>()
        let requestedRole = task.role
        let recoveryContext = ''
        let recoveryWorktree: string | undefined

        for (let attempt = 0; attempt <= maxRateLimitRetries; attempt += 1) {
          attemptedRoles.add(requestedRole)
          const output = await this.dispatch(
            requestedRole,
            recoveryContext
              ? `${taskPrompt}\n\nPrevious worker attempt failed. Continue safely from this concise recovery context:\n${recoveryContext.slice(0, 4_000)}`
              : taskPrompt,
            task.title,
            {
              taskId: runtimeId,
              planId,
              planTaskId: task.id,
              dependsOn: requiredDependencies(task).map((id) => runtimeIds.get(id)!),
              advisoryDependsOn: advisoryDependencies(task).map((id) => runtimeIds.get(id)!),
              conflictKeys: task.conflictKeys,
              expectedFiles: task.expectedFiles,
              criticality: task.criticality,
              ownership: task.ownership,
              attempt: attempt + 1,
              maxAttempts: maxRateLimitRetries + 1,
              recoveryWorktree
            }
          )
          this.taskResults.set(runtimeId, output)
          const runtimeTask = this.tasks.get(runtimeId)
          const terminal = runtimeTask?.status
          if (terminal === 'success' || terminal === 'needs-work' || terminal === 'stopped') {
            results.set(task.id, {
              id: task.id,
              status: terminal,
              criticality: task.criticality,
              result: output,
              commit: runtimeTask?.commit,
              findings: runtimeTask?.findings,
              judgeReason: runtimeTask?.judgeReason
            })
            return
          }

          const rateLimited = Boolean(
            runtimeTask?.provider && detectLimit(runtimeTask.provider, output)
          )
          if (attempt >= (rateLimited ? maxRateLimitRetries : maxRetries)) {
            results.set(task.id, {
              id: task.id,
              status: 'error',
              criticality: task.criticality,
              result: output,
              commit: runtimeTask?.commit,
              findings: runtimeTask?.findings,
              judgeReason: runtimeTask?.judgeReason
            })
            return
          }

          recoveryContext = output
          recoveryWorktree = runtimeTask?.recoveryArtifact?.worktree
          const alternatives = this.listSubagents()
            .filter((agent) =>
              agent.available && !attemptedRoles.has(agent.role) &&
              (!rateLimited || agent.provider !== runtimeTask?.provider)
            )
            .sort((a, b) => (a.busy / a.capacity) - (b.busy / b.capacity))
          if ((!rateLimited && profile?.planner.routingMode !== 'adaptive') || alternatives.length === 0) {
            results.set(task.id, {
              id: task.id,
              status: 'error',
              criticality: task.criticality,
              result: output,
              commit: runtimeTask?.commit,
              findings: runtimeTask?.findings,
              judgeReason: runtimeTask?.judgeReason
            })
            return
          }
          requestedRole = alternatives[0]!.role
          this.reliability.automaticRecoveries += 1
          this.setActivityState(
            'delegating',
            rateLimited
              ? `Provider-Limit erkannt; Recovery ${attempt + 1}/${maxRateLimitRetries} wechselt den Provider.`
              : `Worker-/Pane-Fehler erkannt; Recovery ${attempt + 1}/${maxRetries} auf gesundem Slot.`,
            [`${task.title}: ${requestedRole}`],
            'Ersatz-Worker auswerten und erst danach abhängige Aufgaben freigeben.'
          )
          this.push()
        }
      })()
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error)
          const runtimeTask = this.tasks.get(runtimeId)
          if (runtimeTask) {
            runtimeTask.status = 'error'
            runtimeTask.failureKind = 'infrastructure'
            runtimeTask.note = message
            runtimeTask.judgeReason = `Plan-Dispatch-Infrastruktur fehlgeschlagen: ${message}`
            runtimeTask.lastAction = 'Plan-Dispatch unerwartet fehlgeschlagen'
            runtimeTask.finishedAt = Date.now()
          }
          results.set(task.id, {
            id: task.id,
            status: 'error',
            criticality: task.criticality,
            result: message,
            judgeReason: runtimeTask?.judgeReason ?? `Plan-Dispatch-Infrastruktur fehlgeschlagen: ${message}`
          })
          this.taskResults.set(runtimeId, message)
        })
        .finally(() => {
          active.delete(task.id)
          for (const key of task.conflictKeys) activeConflicts.delete(key)
        })
      active.set(task.id, running)
    }

    while (pending.size > 0 || active.size > 0) {
      if (isCancelled()) {
        for (const task of [...pending.values()]) {
          stopTask(task, 'Planlauf wurde über cancel_plan gestoppt.')
        }
      }
      let stoppedOne: boolean
      do {
        stoppedOne = false
        for (const task of [...pending.values()]) {
          const failedDependency = requiredDependencies(task).find((dependency) => {
            const result = results.get(dependency)
            return result && result.status !== 'success'
          })
          if (failedDependency) {
            stopTask(task, `Erforderliche Abhängigkeit ${failedDependency} ist fehlgeschlagen.`)
            stoppedOne = true
          }
        }
      } while (stoppedOne)

      while (active.size < plan.maxParallel) {
        const next = [...pending.values()].find(
          (task) =>
            requiredDependencies(task).every((dependency) => results.get(dependency)?.status === 'success') &&
            advisoryDependencies(task).every((dependency) => results.has(dependency)) &&
            task.conflictKeys.every((key) => !activeConflicts.has(key))
        )
        if (!next) break
        startTask(next)
      }

      if (active.size === 0 && pending.size > 0) {
        for (const task of [...pending.values()]) {
          stopTask(task, 'Scheduler konnte keinen sicheren nächsten Task bestimmen.')
        }
        break
      }
      if (active.size > 0) await Promise.race(active.values())
    }

    if (!isCancelled()) await this.publishPendingChanges(planId)
    const planTasks = [...this.tasks.values()].filter((task) => task.planId === planId)
    const requiredTasks = planTasks.filter((task) => (task.criticality ?? 'required') === 'required')
    const requiredNeedsWork = requiredTasks.filter((task) => task.status === 'needs-work')
    const requiredErrors = requiredTasks.filter((task) => task.status === 'error')
    const requiredStopped = requiredTasks.filter((task) => task.status === 'stopped')
    const planStatus: ExecutionPlanResult['status'] = isCancelled()
      ? 'stopped'
      : requiredNeedsWork.length > 0
        ? 'needs-work'
        : requiredErrors.length > 0
          ? 'error'
          : requiredStopped.length > 0
            ? 'stopped'
            : 'success'
    const attentionTasks = [...requiredNeedsWork, ...requiredErrors, ...requiredStopped]
    this.reliability.completedPlans += 1
    if (planStatus !== 'success') this.reliability.preventedFalseSuccesses += 1
    const retro = this.recordPlanRetro(planId, plan.goal, planStatus, planTasks)
    this.setActivityState(
      attentionTasks.length > 0 ? 'blocked' : 'summarizing',
      attentionTasks.length > 0
        ? `Der Plan ist wahrheitsgetreu ${planStatus}; ${attentionTasks.length} erforderliche Aufgabe(n) benötigen Aufmerksamkeit.`
        : 'Alle erforderlichen Aufgaben und Integrationsprüfungen sind erfolgreich; advisory Findings bleiben sichtbar.',
      planTasks.slice(-4).map((task) => `${task.agentName ?? task.role}: ${task.title} · ${task.lastAction ?? task.status}`),
      attentionTasks.length > 0
        ? 'Partielle Commits und Blocker erklären und fokussierte Nacharbeit planen.'
        : 'Gesamtergebnis, Prüfstatus und advisory Hinweise berichten.'
    )
    this.push()

    return {
      planId,
      status: planStatus,
      usedFallback: resolved.usedFallback,
      rejected: resolved.rejected,
      validationIssues: resolved.issues,
      retro,
      tasks: plan.tasks.map(
        (task) =>
          results.get(task.id) ?? {
            id: task.id,
            status: 'stopped',
            criticality: task.criticality,
            result: 'Kein Ergebnis.'
          }
      )
    }
  }

  async approvePublication(planId?: string): Promise<boolean> {
    const pending = this.pendingPublication
    if (!pending || this.publicationInFlight) return false
    if (planId && pending.id !== `publication:${this.workspaceSessionId ?? 'workspace'}:${planId}`) return false
    this.pendingPublication = undefined
    this.publicationInFlight = true
    this.push()
    try {
      await this.publishPendingChanges(planId ?? pending.task?.planId, true)
      return true
    } finally {
      this.publicationInFlight = false
      this.push()
    }
  }

  rejectPublication(planId?: string): boolean {
    const pending = this.pendingPublication
    if (!pending || this.publicationInFlight) return false
    if (planId && pending.id !== `publication:${this.workspaceSessionId ?? 'workspace'}:${planId}`) return false
    const targetPlanId = planId ?? pending.task?.planId
    for (const [taskId] of [...this.preparedChanges.entries()]) {
      const task = this.tasks.get(taskId)
      if (targetPlanId != null && task?.planId !== targetPlanId) continue
      if (task) {
        task.autoPrStatus = 'skipped'
        task.note = `${task.note || 'Task fertig'} · Veröffentlichung abgelehnt.`
      }
      this.preparedChanges.delete(taskId)
    }
    this.pendingPublication = undefined
    this.setActivityState(
      'blocked',
      'Die vorbereitete Pull-Request-Veröffentlichung wurde abgelehnt.',
      [],
      'Auf ein neues Ziel oder eine erneute lokale Vorbereitung warten.'
    )
    this.push()
    return true
  }

  private async publishPendingChanges(planId?: string, publicationApproved = false): Promise<void> {
    const profile = this.activeProfile()
    if (!profile || profile.autoPr.mode === 'off') return
    const changes = [...this.preparedChanges.entries()]
      .filter(([taskId]) => {
        const task = this.tasks.get(taskId)
        return task?.autoPrStatus === 'prepared' && (planId == null || task.planId === planId)
      })
      .map(([, change]) => change)
    if (changes.length === 0) return

    if (profile.autoPr.mode === 'hold-for-approval' && !publicationApproved) {
      const scope = this.workspaceSessionId ?? 'workspace'
      const representative = [...this.tasks.values()].find((task) =>
        task.autoPrStatus === 'prepared' && (planId == null || task.planId === planId)
      )
      this.pendingPublication = {
        id: `publication:${scope}:${planId ?? 'current'}`,
        kind: 'pr-publication',
        profileId: profile.id,
        workspaceSessionId: scope,
        title: 'Pull Request zur Veröffentlichung bereit',
        summary: `${changes.length} vorbereitete Änderung(en) haben die lokalen Gates bestanden.`,
        createdAt: Date.now(),
        task: representative,
        actions: ['publication.approve', 'publication.reject']
      }
      this.setActivityState(
        'awaiting-review',
        'Die geprüften Änderungen sind vorbereitet und warten vor der PR-Veröffentlichung auf Freigabe.',
        changes.slice(0, 4).map((change) => `${change.title}: ${change.commit.slice(0, 8)}`),
        'Veröffentlichung freigeben oder ablehnen.'
      )
      this.push()
      return
    }

    const integrationId = 'integration-' + (planId ?? Date.now().toString(36))
    const integrationTask: OrcaTask = {
      id: integrationId,
      title: 'Integration & Abnahme',
      role: 'integrator',
      status: 'running',
      criticality: 'required',
      ownership: 'integrator',
      engineId: this.engineId,
      phase: 'integrating',
      progress: 25,
      lastAction: 'Übernimmt verifizierte Task-Commits',
      lastHeartbeatAt: Date.now(),
      planId,
      createdAt: Date.now()
    }
    const changedCommits = new Set(changes.map((change) => change.commit))
    const affectedTasks = (): OrcaTask[] => [...this.tasks.values()].filter(
      (task) => Boolean(task.commit && changedCommits.has(task.commit))
    )
    const applyRemoteCi = (remoteCi: RemoteCiOutcome): void => {
      integrationTask.status = 'running'
      integrationTask.phase = 'testing'
      integrationTask.progress = remoteCi.status === 'waiting' ? 70 : remoteCi.status === 'pending' ? 85 : 95
      integrationTask.lastAction = remoteCi.message
      integrationTask.lastHeartbeatAt = Date.now()
      integrationTask.remoteCiStatus = remoteCi.status
      integrationTask.remoteCiUrl = remoteCi.url
      integrationTask.remoteCiSummary = remoteCi.message
      for (const task of affectedTasks()) {
        task.remoteCiStatus = remoteCi.status
        task.remoteCiUrl = remoteCi.url
        task.remoteCiSummary = remoteCi.message
      }
      this.setActivityState(
        'reviewing',
        remoteCi.message,
        ['Remote-CI und Pull-Request-Status werden unabhängig vom Worker-Ergebnis geprüft.'],
        'Auf einen terminalen CI-Status warten und das Resultat einordnen.'
      )
      this.push()
    }

    this.tasks.set(integrationId, integrationTask)
    this.setActivityState(
      'integrating',
      'Führt die verifizierten Subagent-Commits zusammen und startet die Abnahme.',
      changes.slice(0, 4).map((change) => `${change.title}: ${change.commit.slice(0, 8)}`),
      'Security-Gates, Pull Request und Remote-CI prüfen.'
    )
    this.push()

    const outcome = await publishPreparedChanges({
      config: profile.autoPr,
      goalId: this.goal?.id ?? planId ?? 'goal',
      goalTitle: this.goal?.title ?? 'Orca-Strator Aufgabe',
      changes,
      profileDefaultBranch: profileDefaultBaseBranch(profile),
      onRemoteCiUpdate: applyRemoteCi
    })
    const remoteStatus = outcome.remoteCi?.status
    const remoteFailed = remoteStatus === 'failed' || remoteStatus === 'cancelled'
    const remoteIncomplete = remoteStatus === 'timed-out' || remoteStatus === 'unavailable'
    integrationTask.status = outcome.status === 'blocked' || remoteFailed
      ? 'error'
      : remoteIncomplete ? 'stopped' : 'success'
    if (integrationTask.status === 'error') {
      integrationTask.failureKind = 'gate'
      integrationTask.judgeReason = remoteFailed
        ? `Remote-CI bewertete die Integration als fehlgeschlagen: ${outcome.remoteCi?.message ?? outcome.message}`
        : `Integrationsabnahme wurde blockiert: ${outcome.message}`
    }
    integrationTask.phase = outcome.status === 'blocked'
      ? 'security-review'
      : remoteStatus && remoteStatus !== 'passed' ? 'testing' : 'completed'
    integrationTask.progress = integrationTask.status === 'success' ? 100 : undefined
    integrationTask.lastAction = outcome.message
    integrationTask.lastHeartbeatAt = Date.now()
    integrationTask.finishedAt = Date.now()
    integrationTask.completion = { kind: 'no-changes' }
    integrationTask.prUrl = outcome.url
    integrationTask.autoPrStatus = outcome.status
    integrationTask.remoteCiStatus = remoteStatus
    integrationTask.remoteCiUrl = outcome.remoteCi?.url
    integrationTask.remoteCiSummary = outcome.remoteCi?.message
    if (outcome.remoteCi && outcome.remoteCi.status !== 'passed') {
      integrationTask.note = outcome.remoteCi.message
    }

    for (const task of affectedTasks()) {
      task.autoPrStatus = outcome.status
      task.prUrl = outcome.url
      task.remoteCiStatus = remoteStatus
      task.remoteCiUrl = outcome.remoteCi?.url
      task.remoteCiSummary = outcome.remoteCi?.message
      if (outcome.status === 'blocked') {
        task.note = `${task.note || 'Task fertig'} · Auto-PR blockiert: ${outcome.message}`
      } else if (outcome.remoteCi && outcome.remoteCi.status !== 'passed') {
        task.note = `${task.note || 'Task fertig'} · Remote-CI: ${outcome.remoteCi.message}`
      }
      this.preparedChanges.delete(task.id)
    }
    this.setActivityState(
      integrationTask.status === 'error' ? 'blocked' : 'summarizing',
      integrationTask.status === 'error'
        ? `Integration oder Remote-CI benötigt Aufmerksamkeit: ${outcome.message}`
        : 'Integration und Abnahme sind beendet; der Orchestrator bereitet den Abschlussbericht vor.',
      [integrationTask.lastAction],
      integrationTask.status === 'error' ? 'Blocker und Wiederholungsoptionen erklären.' : 'PR-, CI- und Commit-Status zusammenfassen.'
    )
    this.push()
  }


  /**
   * Automatic retrospective after every terminal plan run: aggregate per-model
   * stats, derive conservative heuristic learnings, persist both and surface
   * the retro on the snapshot. Must never be able to fail the plan itself.
   */
  private recordPlanRetro(
    planId: string,
    goal: string,
    status: ExecutionPlanResult['status'],
    planTasks: OrcaTask[]
  ): RunRetro | undefined {
    // Selbsttests sind keine Modellbeobachtungen: weder lokal lernen noch
    // exportieren, sonst entstehen fabrizierte Weakness-Learnings.
    if (this.workspaceSessionId === REMOTE_SELFTEST_SESSION_ID) return undefined
    try {
      const analysis = analyzeRunRetro({
        tasks: planTasks,
        status,
        profileId: this.boundProfile?.id
      })
      if (analysis.modelStats.length === 0) return undefined
      const learnings = recordModelLearnings(analysis.learnings)
      const retro: RunRetro = {
        id: `retro-${Date.now().toString(36)}-${planId}`,
        profileId: this.boundProfile?.id,
        workspaceSessionId: this.workspaceSessionId,
        planId,
        goal,
        status,
        summary: analysis.summary,
        modelStats: analysis.modelStats,
        learnings,
        createdAt: Date.now()
      }
      recordRunRetro(retro)
      this.lastRetro = retro
      return retro
    } catch (error) {
      console.warn('[Orchestrator] Automatische Retro fehlgeschlagen', error)
      return undefined
    }
  }

  private storedRetros(): RunRetro[] {
    try {
      return listRunRetros(this.boundProfile?.id)
    } catch (error) {
      console.warn('[Orchestrator] Retros nicht lesbar', error)
      return []
    }
  }

  private retroForPlan(planId: string): RunRetro | undefined {
    if (this.lastRetro?.planId === planId) return this.lastRetro
    return this.storedRetros().find((retro) =>
      retro.planId === planId &&
      (
        this.workspaceSessionId == null ||
        retro.workspaceSessionId == null ||
        retro.workspaceSessionId === this.workspaceSessionId
      )
    )
  }

  /**
   * A retro card satisfies the qualitative gate once the orchestrator has
   * merged its own learnings via record_retro. Auto-retro (heuristic, source
   * 'auto-retro') alone does NOT count — the numbers are captured, the
   * qualitative judgement is not.
   */
  private retroHasQualitativeLearnings(retro: RunRetro | undefined): boolean {
    return retro?.learnings.some((learning) => learning.source === 'orchestrator') ?? false
  }

  /** True when the latest terminal plan run still lacks a qualitative retro. */
  private isRetroPending(planId: string | undefined): boolean {
    if (!planId) return false
    if (this.workspaceSessionId === REMOTE_SELFTEST_SESSION_ID) return false
    return !this.retroHasQualitativeLearnings(this.retroForPlan(planId))
  }

  /** Non-blocking reminder for set_goal when the prior run's retro is open. */
  private pendingRetroReminder(): RetroReminder | undefined {
    const planId = this.latestTerminalPlanId()
    if (!this.isRetroPending(planId) || !planId) return undefined
    return {
      priorPlanId: planId,
      message:
        `Für den letzten terminalen Planlauf (${planId}) wurde noch kein qualitatives Retro erfasst. ` +
        'Rufe get_retro_draft/record_retro nach, damit die Modell-Learnings dieses Laufs nicht verloren gehen.'
    }
  }

  /**
   * Assemble the terminal await_plan payload and surface the retro gate: when
   * the run's qualitative retro is still open, embed retroPending plus the
   * ready-to-fill draft so the next natural step is recording the retro — no
   * separate get_retro_draft round-trip required.
   */
  private terminalAwaitResult(runId: string, plan: PlanRunStatusSnapshot): AwaitPlanResult {
    const base = { done: true as const, stillRunning: false as const, plan }
    const planId = this.planRunPlanIds.get(runId)
    if (!this.isRetroPending(planId)) {
      return planId ? { ...base, retroPending: false } : base
    }
    return { ...base, retroPending: true, retroDraft: this.buildRetroDraft(planId) }
  }

  private latestTerminalPlanId(): string | undefined {
    const latestRun = [...this.planRunResults.values()].reverse().find(
      (run) => run.planId && run.status !== 'running'
    )
    if (latestRun?.planId) return latestRun.planId
    if (this.lastRetro?.planId && this.lastRetro.planId !== 'ad-hoc' && this.lastRetro.status) {
      return this.lastRetro.planId
    }
    return this.storedRetros().find((retro) =>
      retro.planId !== 'ad-hoc' &&
      retro.status != null &&
      (
        this.workspaceSessionId == null ||
        retro.workspaceSessionId == null ||
        retro.workspaceSessionId === this.workspaceSessionId
      )
    )?.planId
  }

  private resolveRetroModel(provider: AgentProviderId, model?: string, role?: string): string {
    const configured = this.slotsWithRoles().find(
      (entry) => entry.slot.provider === provider && (role == null || entry.role === role)
    )?.slot
    return resolveSlotModel(provider, model?.trim() ? { model } : (configured ?? { model: '' }))
  }

  private resolvedRetroTasks(planId: string): OrcaTask[] {
    return [...this.tasks.values()]
      .filter((task) => task.planId === planId)
      .map((task) => ({
        ...task,
        model: task.provider
          ? this.resolveRetroModel(task.provider, task.model, task.role)
          : task.model,
        attempts: task.attempts?.map((attempt) => ({
          ...attempt,
          model: attempt.provider
            ? this.resolveRetroModel(attempt.provider, attempt.model, task.role)
            : attempt.model
        }))
      }))
  }

  /** Facts scaffold for the latest terminal plan (or an explicitly selected one). */
  buildRetroDraft(requestedPlanId?: string): RetroDraftResult {
    const planId = requestedPlanId?.trim() || this.latestTerminalPlanId()
    if (!planId) {
      return {
        ok: false,
        code: 'no-terminal-plan',
        message: 'Es liegt noch kein terminaler Planlauf für eine Retrospektive vor.'
      }
    }

    const run = [...this.planRunResults.values()].reverse().find((entry) => entry.planId === planId)
    const retro = this.retroForPlan(planId)
    const tasks = this.resolvedRetroTasks(planId)
    if (!run && !retro && tasks.length === 0) {
      return {
        ok: false,
        code: 'plan-not-found',
        planId,
        message: `Planlauf ${planId} ist unbekannt.`
      }
    }
    if (
      run?.status === 'running' ||
      tasks.some((task) => !isTerminalTaskStatus(task.status))
    ) {
      return {
        ok: false,
        code: 'plan-not-terminal',
        planId,
        message: `Planlauf ${planId} ist noch nicht terminal.`
      }
    }

    const status = retro?.status ?? run?.status
    if (!status) {
      return {
        ok: false,
        code: 'plan-not-terminal',
        planId,
        message: `Für Planlauf ${planId} liegt noch kein terminaler Status vor.`
      }
    }
    const models = deriveRetroDraftModels(tasks)
    if (models.length === 0) {
      return {
        ok: false,
        code: 'no-model-stats',
        planId,
        message: `Planlauf ${planId} enthält keine auswertbaren Modellbeobachtungen.`
      }
    }
    const analysis = analyzeRunRetro({
      tasks,
      status,
      profileId: this.boundProfile?.id
    })
    return {
      ok: true,
      planId,
      goal: run?.goal ?? retro?.goal ?? this.goal?.title ?? '',
      status,
      summary: retro?.summary ?? analysis.summary,
      models
    }
  }

  /**
   * Qualitative retro recorded by the orchestrator itself (record_retro tool),
   * e.g. "Modell X war sehr stark bei UI-Aufgaben". Learnings merge into the
   * persistent store and attach to the current run's retro card.
   */
  recordOrchestratorRetro(input: {
    summary: string
    learnings: Array<{
      provider: AgentProviderId
      model: string
      role?: string
      kind: LearningKind
      insight: string
      evidence?: string
    }>
  }): { summary: string; storedLearnings: ModelLearning[] } {
    const summary = input.summary.replace(/\s+/g, ' ').trim().slice(0, 500)
    if (this.workspaceSessionId === REMOTE_SELFTEST_SESSION_ID) {
      return { summary, storedLearnings: [] }
    }
    const applied = recordModelLearnings(
      input.learnings.map((learning) => ({
        ...learning,
        model: this.resolveRetroModel(learning.provider, learning.model, learning.role),
        source: 'orchestrator' as const,
        profileId: this.boundProfile?.id
      }))
    )
    const planId = this.latestTerminalPlanId()
    const existing = planId ? this.retroForPlan(planId) : this.lastRetro
    let base = existing
    if (!base && planId) {
      const run = [...this.planRunResults.values()].reverse().find((entry) => entry.planId === planId)
      const tasks = this.resolvedRetroTasks(planId)
      const status = run?.status === 'running' ? undefined : run?.status
      const analysis = analyzeRunRetro({ tasks, status, profileId: this.boundProfile?.id })
      base = {
        id: `retro-${Date.now().toString(36)}-${planId}`,
        profileId: this.boundProfile?.id,
        workspaceSessionId: this.workspaceSessionId,
        planId,
        goal: run?.goal ?? this.goal?.title ?? '',
        status,
        summary: analysis.summary,
        modelStats: analysis.modelStats,
        learnings: recordModelLearnings(analysis.learnings),
        createdAt: Date.now()
      }
    }
    if (!base) {
      base = {
        id: `retro-${Date.now().toString(36)}-adhoc`,
        profileId: this.boundProfile?.id,
        workspaceSessionId: this.workspaceSessionId,
        planId: 'ad-hoc',
        goal: this.goal?.title ?? '',
        summary: summary || 'Retro ohne Planlauf aufgezeichnet.',
        modelStats: analyzeRunRetro({ tasks: [...this.tasks.values()] }).modelStats,
        learnings: applied,
        createdAt: Date.now()
      }
    }
    const learningsById = new Map(base.learnings.map((entry) => [entry.id, entry]))
    for (const learning of applied) learningsById.set(learning.id, learning)
    const shouldQueueExport = base.exportQueuedAt == null
    this.lastRetro = {
      ...base,
      summary: summary || base.summary,
      learnings: [...learningsById.values()],
      exportQueuedAt: base.exportQueuedAt ?? Date.now()
    }
    recordRunRetro(this.lastRetro)
    if (shouldQueueExport) enqueueRetroExport(this.lastRetro)
    this.push()
    return { summary: this.lastRetro.summary, storedLearnings: applied }
  }

  /**
   * Auto-Benchmark: fan the SAME prompt out to every dispatchable slot. Each
   * contestant runs in its own isolated worktree; results are polled like any
   * other task and finally judged via recordBenchmark.
   */
  runBenchmarkAsync(prompt: string, title?: string): BenchmarkRunStatus {
    const entries = this.slotsWithRoles()
    if (entries.length === 0) {
      throw new Error('Kein orchestrierbarer Slot für den Benchmark verfügbar.')
    }
    this.benchSeq += 1
    const benchmarkId = `bench-${Date.now().toString(36)}-${this.benchSeq.toString(36)}`
    const benchTitle = title?.trim() || prompt.split('\n')[0].slice(0, 48)
    const tasks = entries.map(({ role }) =>
      this.dispatchAsync(role, prompt, `Benchmark · ${benchTitle} · ${role}`)
    )
    this.benchmarkRuns.set(benchmarkId, {
      benchmarkId,
      title: benchTitle,
      prompt,
      taskIds: tasks.map((task) => task.taskId),
      startedAt: Date.now()
    })
    this.setActivityState(
      'delegating',
      `Benchmark „${benchTitle}“: dieselbe Aufgabe läuft parallel auf ${tasks.length} Slot(s).`,
      entries.slice(0, 4).map(({ slot, role }) => `${role}: ${slot.provider}/${resolveSlotModel(slot.provider, slot) || 'Standard'}`),
      'Alle Läufe bis zum Terminalstatus verfolgen und danach fair bewerten.'
    )
    this.push()
    return { benchmarkId, title: benchTitle, status: 'running', tasks }
  }

  getBenchmarkStatus(benchmarkId: string): BenchmarkRunStatus | undefined {
    const run = this.benchmarkRuns.get(benchmarkId)
    if (!run) return undefined
    const tasks: Array<TaskStatusSnapshot & { durationMs?: number }> = []
    for (const taskId of run.taskIds) {
      const status = this.getTaskStatus(taskId)
      if (!status) continue
      const task = this.tasks.get(taskId)
      const durationMs = task?.finishedAt != null && task.finishedAt > task.createdAt
        ? task.finishedAt - task.createdAt
        : undefined
      tasks.push({ ...status, durationMs })
    }
    const terminal = tasks.every(
      (task) => task.status === 'success' || task.status === 'needs-work' ||
        task.status === 'error' || task.status === 'stopped'
    )
    return {
      benchmarkId,
      title: run.title,
      status: tasks.length > 0 && terminal ? 'completed' : 'running',
      tasks
    }
  }

  /**
   * Persist the orchestrator's benchmark judgement and convert it into model
   * learnings (background knowledge for future routing).
   */
  recordBenchmark(input: {
    benchmarkId: string
    task: string
    summary: string
    rankings: Array<Omit<BenchmarkRanking, 'strengths' | 'weaknesses'> & {
      strengths?: string[]
      weaknesses?: string[]
    }>
  }): BenchmarkRecord {
    const run = this.benchmarkRuns.get(input.benchmarkId)
    const resolveContestant = (role: string): OrcaTask | undefined => {
      if (!run) return undefined
      return run.taskIds
        .map((taskId) => this.tasks.get(taskId))
        .find((task) => task?.role === role)
    }
    const rankings: BenchmarkRanking[] = input.rankings.map((ranking) => {
      const contestant = resolveContestant(ranking.role)
      const tokens = contestant?.usage?.tokensIn != null || contestant?.usage?.tokensOut != null
        ? (contestant?.usage?.tokensIn ?? 0) + (contestant?.usage?.tokensOut ?? 0)
        : undefined
      return {
        ...ranking,
        provider: ranking.provider ?? contestant?.provider,
        model: ranking.model ?? contestant?.model,
        strengths: ranking.strengths ?? [],
        weaknesses: ranking.weaknesses ?? [],
        durationMs: ranking.durationMs ?? (
          contestant?.finishedAt && contestant.finishedAt > contestant.createdAt
            ? contestant.finishedAt - contestant.createdAt
            : undefined
        ),
        tokens: ranking.tokens ?? tokens
      }
    })
    const record: BenchmarkRecord = {
      id: `benchrec-${Date.now().toString(36)}`,
      benchmarkId: input.benchmarkId,
      profileId: this.boundProfile?.id,
      task: input.task.replace(/\s+/g, ' ').trim().slice(0, 500),
      summary: input.summary.replace(/\s+/g, ' ').trim().slice(0, 800),
      rankings,
      createdAt: Date.now()
    }
    recordBenchmarkRecord(record)
    enqueueBenchmarkExport(record)
    recordModelLearnings(benchmarkLearnings(record, rankings))
    this.setActivityState(
      'summarizing',
      `Benchmark bewertet: ${record.summary}`.slice(0, 280),
      rankings
        .slice()
        .sort((a, b) => b.score - a.score)
        .slice(0, 4)
        .map((ranking) => `${ranking.role} (${ranking.provider ?? '?'}/${ranking.model || 'Standard'}): ${ranking.score}/10`),
      'Rangliste und gespeicherte Erkenntnisse dem Nutzer berichten.'
    )
    this.push()
    return record
  }

  /** Start a complete DAG without keeping the MCP request open. */
  executePlanAsync(input: unknown): PlanRunStatusSnapshot {
    this.planRunSeq += 1
    const runId = `plan-run-${Date.now().toString(36)}-${this.planRunSeq.toString(36)}`
    let prepared: PreparedExecutionPlan
    try {
      prepared = this.prepareExecutionPlan(input)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const failed: PlanRunStatusSnapshot = {
        runId,
        status: 'error',
        engineId: this.engineId,
        workspaceSessionId: this.workspaceSessionId,
        validationIssues: [],
        planTaskIds: [],
        error: message
      }
      this.planRunResults.set(runId, failed)
      return failed
    }

    // Ein abgelehnter strukturierter Plan läuft als konservativer Fallback
    // durch das Review-Gate weiter, statt ohne Nutzer-Signal zu verschwinden.
    const validation = {
      usedFallback: prepared.resolved.usedFallback,
      rejected: prepared.resolved.rejected,
      validationIssues: prepared.resolved.issues,
      planTaskIds: prepared.plan.tasks.map((task) => task.id)
    }
    const planId = this.nextPlanId()
    const initial: PlanRunStatusSnapshot = {
      runId,
      status: 'running',
      engineId: this.engineId,
      workspaceSessionId: this.workspaceSessionId,
      planId,
      goal: prepared.plan.goal,
      ...validation
    }
    this.planRunResults.set(runId, initial)
    const run = this.executePreparedPlan(prepared, runId, planId)
      .then((result) => {
        this.planRunResults.set(runId, {
          ...(this.planRunResults.get(runId) ?? initial),
          status: result.status,
          planId: result.planId,
          result
        })
        return result
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error)
        this.planRunResults.set(runId, {
          ...(this.planRunResults.get(runId) ?? initial),
          status: 'error',
          error: message
        })
        throw error
      })
    this.planRuns.set(runId, run)
    void run.catch(() => undefined).finally(() => {
      this.planRuns.delete(runId)
      this.cancelledPlanRuns.delete(runId)
    })
    return initial
  }

  async cancelPlan(runId?: string): Promise<CancelPlanResult> {
    if (!runId) {
      const pending = this.pendingPlan
      if (!pending || !this.pendingPlanResolve) {
        return { ok: false, message: 'Kein Plan wartet derzeit auf Freigabe.' }
      }
      this.reviewPlan(false)
      return {
        ok: true,
        planId: pending.planId,
        status: 'stopped',
        message: `Review-Plan ${pending.planId} wurde verworfen; der Review-Slot ist frei.`
      }
    }

    const stored = this.planRunResults.get(runId)
    if (!stored) {
      return { ok: false, runId, message: `Planlauf ${runId} ist unbekannt.` }
    }
    if (stored.status !== 'running') {
      return {
        ok: false,
        runId,
        planId: stored.planId,
        message: `Planlauf ${runId} ist bereits terminal (${stored.status}).`
      }
    }

    this.cancelledPlanRuns.add(runId)
    const planId = stored.planId ?? this.planRunPlanIds.get(runId)
    if (planId && this.pendingPlan?.planId === planId) this.reviewPlan(false)
    const reason = 'Planlauf wurde über cancel_plan gestoppt.'
    const runningAgentIds: string[] = []
    for (const task of this.tasks.values()) {
      if (task.planId !== planId || !['queued', 'running', 'waiting', 'paused'].includes(task.status)) continue
      if (task.status !== 'queued' && task.agentId) runningAgentIds.push(task.agentId)
      Object.assign(task, {
        status: 'stopped' as const,
        failureKind: 'cancelled' as const,
        note: reason,
        judgeReason: reason,
        lastAction: reason,
        finishedAt: Date.now()
      })
      this.taskResults.set(task.id, reason)
    }
    await Promise.allSettled(runningAgentIds.map((agentId) => agentManager.kill(agentId)))
    const latest = this.planRunResults.get(runId) ?? stored
    this.planRunResults.set(runId, {
      ...latest,
      status: 'stopped',
      planId,
      error: undefined
    })
    this.setActivityState(
      'blocked',
      `Planlauf ${runId} wurde gestoppt.`,
      [`${runningAgentIds.length} laufende Worker beendet; wartende Tasks verworfen.`],
      'Bei Bedarf einen neuen oder angepassten Plan einreichen.'
    )
    this.push()
    return { ok: true, runId, planId, status: 'stopped', message: reason }
  }

  getPlanRunStatus(runId: string): PlanRunStatusSnapshot | undefined {
    const stored = this.planRunResults.get(runId)
    if (!stored) return undefined
    const planId = stored.planId ?? this.planRunPlanIds.get(runId)
    const tasks = planId
      ? [...this.tasks.values()]
          .filter((task) => task.planId === planId)
          .map((task) => this.getTaskStatus(task.id))
          .filter((task): task is TaskStatusSnapshot => Boolean(task))
      : []
    return {
      ...stored,
      engineId: this.engineId,
      workspaceSessionId: this.workspaceSessionId,
      planId,
      goal: stored.goal ?? this.goal?.title,
      reviewState: (planId ? this.planReviewStates.get(planId) : undefined) ?? 'not-required',
      tasks,
      summary: {
        required: tasks.filter((task) => (task.criticality ?? 'required') === 'required').length,
        advisory: tasks.filter((task) => task.criticality === 'advisory').length,
        running: tasks.filter((task) => ['queued', 'running', 'waiting', 'paused'].includes(task.status)).length,
        succeeded: tasks.filter((task) => task.status === 'success').length,
        needsWork: tasks.filter((task) => task.status === 'needs-work').length,
        failed: tasks.filter((task) => task.status === 'error' || task.status === 'stopped').length
      }
    }
  }

  /**
   * Structured self-report from a running subagent (report_progress tool).
   * Replaces heuristic output parsing with the worker's own account of what it
   * is doing; feeds the same fields the orchestrator polls via get_task_status.
   */
  reportSubagentProgress(
    taskId: string,
    input: { message: string; phase?: Extract<TaskPhase, 'working' | 'testing' | 'committing'> }
  ): TaskStatusSnapshot | undefined {
    const task = this.tasks.get(taskId)
    if (!task) return undefined
    const clean = input.message.replace(/\s+/g, ' ').trim().slice(0, 220)
    if (clean) {
      task.lastAction = `Worker meldet: ${clean}`
      this.rememberTaskAction(task)
    }
    if (input.phase && task.status === 'running') task.phase = input.phase
    task.lastHeartbeatAt = Date.now()
    this.push()
    return this.getTaskStatus(taskId)
  }

  /**
   * A subagent shares an interface, decision, blocker or insight with the
   * orchestrator and its parallel peers. Board entries are bounded and scoped:
   * plan tasks see their plan (plus plan-less ad-hoc entries), everything is
   * visible to the orchestrator.
   */
  postTaskFinding(
    taskId: string,
    input: { kind: SubagentFindingKind; title: string; detail: string; files?: string[] }
  ): SubagentFinding {
    const task = this.tasks.get(taskId)
    if (!task) throw new Error('Task nicht gefunden.')
    const clean = (value: string, max: number): string =>
      value.replace(/\s+/g, ' ').trim().slice(0, max)
    const title = clean(input.title, 160)
    const detail = input.detail.trim().slice(0, 2_000)
    if (!title || !detail) throw new Error('Finding benötigt Titel und Inhalt.')
    this.findingSeq += 1
    const finding: SubagentFinding = {
      id: `finding-${this.findingSeq.toString(36)}`,
      taskId,
      planId: task.planId,
      agentName: task.agentName,
      role: task.role,
      kind: input.kind,
      title,
      detail,
      files: input.files
        ?.map((file) => file.trim())
        .filter(Boolean)
        .slice(0, 32),
      createdAt: Date.now()
    }
    this.findingsBoard.push(finding)
    if (this.findingsBoard.length > MAX_BOARD_FINDINGS) {
      this.findingsBoard.splice(0, this.findingsBoard.length - MAX_BOARD_FINDINGS)
    }
    task.lastAction = `Finding geteilt: ${title}`
    this.rememberTaskAction(task)
    task.lastHeartbeatAt = Date.now()
    this.push()
    return finding
  }

  /**
   * Board entries visible to a task (same plan + plan-less entries), or the
   * complete board when no task scope is given (orchestrator view).
   */
  listTaskFindings(taskId?: string): SubagentFinding[] {
    const task = taskId ? this.tasks.get(taskId) : undefined
    const planId = task?.planId
    const visible = planId
      ? this.findingsBoard.filter((finding) => finding.planId === planId || !finding.planId)
      : [...this.findingsBoard]
    return visible.slice(-MAX_FINDINGS_RESPONSE).map((finding) => ({
      ...finding,
      files: finding.files ? [...finding.files] : undefined
    }))
  }

  /** Open a persistent interactive subagent in its own OS window. */
  requestSubagentSupport(
    taskId: string,
    input: { question: string; context?: string }
  ): SubagentSupportRequest {
    const task = this.tasks.get(taskId)
    if (!task) throw new Error('Task nicht gefunden.')
    const question = input.question.replace(/\s+/g, ' ').trim().slice(0, 1_000)
    if (!question) throw new Error('Die Rückfrage darf nicht leer sein.')
    this.supportSeq += 1
    const request: SubagentSupportRequest = {
      id: `support-${this.supportSeq.toString(36)}`,
      taskId, agentName: task.agentName, role: task.role, question,
      context: input.context?.trim().slice(0, 2_000) || undefined,
      status: 'pending', createdAt: Date.now()
    }
    this.subagentRequests.set(request.id, request)
    task.lastAction = `Rückfrage an Orchestrator: ${question.slice(0, 120)}`
    task.lastHeartbeatAt = Date.now()
    this.rememberTaskAction(task)
    this.setActivityState(
      'monitoring',
      `${task.agentName ?? task.role} benötigt eine Orchestrator-Entscheidung.`,
      [question.slice(0, 220)],
      'Rückfrage beantworten oder den Task gezielt stoppen.'
    )
    this.push()
    return { ...request }
  }

  listSubagentSupportRequests(pendingOnly = false): SubagentSupportRequest[] {
    return [...this.subagentRequests.values()]
      .filter((request) => !pendingOnly || request.status === 'pending')
      .sort((a, b) => a.createdAt - b.createdAt)
      .slice(-100)
      .map((request) => ({ ...request }))
  }

  private notifySupportWaiters(request: SubagentSupportRequest): void {
    const waiters = this.supportWaiters.get(request.id)
    if (!waiters) return
    this.supportWaiters.delete(request.id)
    for (const resolve of waiters) resolve({ ...request })
  }

  async awaitSubagentSupportResponse(requestId: string, timeoutMs = AWAIT_DEFAULT_TIMEOUT_MS): Promise<
    { done: true; request: SubagentSupportRequest } |
    { done: false; stillWaiting: true; request: SubagentSupportRequest }
  > {
    const request = this.subagentRequests.get(requestId)
    if (!request) throw new Error('Rückfrage nicht gefunden.')
    if (request.status !== 'pending') return { done: true, request: { ...request } }
    const wait = Math.min(AWAIT_MAX_TIMEOUT_MS, Math.max(AWAIT_MIN_TIMEOUT_MS, timeoutMs))
    return new Promise((resolve) => {
      const callback = (resolved: SubagentSupportRequest): void => {
        clearTimeout(timer)
        resolve({ done: true, request: resolved })
      }
      const listeners = this.supportWaiters.get(requestId) ?? new Set()
      listeners.add(callback)
      this.supportWaiters.set(requestId, listeners)
      const timer = setTimeout(() => {
        listeners.delete(callback)
        if (listeners.size === 0) this.supportWaiters.delete(requestId)
        resolve({ done: false, stillWaiting: true, request: { ...request } })
      }, wait)
    })
  }

  async respondSubagentSupport(
    requestId: string,
    response: string,
    action: 'continue' | 'stop' = 'continue'
  ): Promise<SubagentSupportRequest> {
    const request = this.subagentRequests.get(requestId)
    if (!request) throw new Error('Rückfrage nicht gefunden.')
    if (request.status !== 'pending') return { ...request }
    const clean = response.replace(/\s+/g, ' ').trim().slice(0, 2_000)
    if (!clean) throw new Error('Die Antwort darf nicht leer sein.')
    request.response = clean
    request.respondedAt = Date.now()
    request.status = action === 'stop' ? 'stopped' : 'answered'
    const task = this.tasks.get(request.taskId)
    if (task) {
      task.lastAction = action === 'stop'
        ? `Orchestrator stoppte den Task: ${clean.slice(0, 120)}`
        : `Orchestrator antwortete: ${clean.slice(0, 120)}`
      task.lastHeartbeatAt = Date.now()
      this.rememberTaskAction(task)
      if (action === 'stop' && task.agentId && !isTerminalTaskStatus(task.status)) {
        await agentManager.kill(task.agentId)
      }
    }
    this.notifySupportWaiters(request)
    this.push()
    return { ...request }
  }

  async openSubwindow(role: string, prompt?: string): Promise<string> {
    const { slot, role: slotRole } = this.pickSlot(role)
    const profile = this.activeProfile()
    const info = await agentManager.spawn({
      provider: slot.provider,
      model: slot.model,
      modelPreset: slot.modelPreset,
      role: `Subagent · ${slotRole}`,
      kind: 'sub',
      yolo: slot.yolo || (profile?.yoloDefault ?? false),
      workingDir: slot.workingDir || profile?.workingDir,
      profileId: profile?.id,
      workspaceSessionId: this.workspaceSessionId,
      engineId: this.engineId
    })
    createPaneWindow(info.id)
    if (prompt) {
      void agentManager.seedInteractive(info.id, prompt)
    }
    return info.id
  }
}

export const orchestratorEngine = new OrchestratorEngine()
