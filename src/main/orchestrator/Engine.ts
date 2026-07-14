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
  ExecutionPlanResult,
  ExecutionPlanTask,
  ExecutionPlanTaskResult,
  OrcaTask,
  OrchestratorActivity,
  OrchestratorActivityPhase,
  OrchestratorGoal,
  OrchestratorReliabilityMetrics,
  PendingPlanReview,
  OrchestratorSnapshot,
  PlanRunStatusSnapshot,
  SubagentDescriptor,
  TaskAttemptSnapshot,
  TaskCriticality,
  TaskStatusSnapshot
} from '@shared/orchestrator'
import {
  agentSlotsWithRoles,
  agentSlotCapabilities,
  profileDefaultBaseBranch,
  type AgentSlot,
  type WorkspaceProfile
} from '@shared/profile'
import { resolveModel } from '@shared/models'
import {
  isModelDisabled,
  normalizeDisabledModels,
  normalizeProviderEnabled,
  type AgentProviderId
} from '@shared/providers'
import { agentManager } from '@main/agents/AgentManager'
import { PanePreflightError } from '@main/agents/panePreflight'
import { stripAnsi } from '@main/agents/limitSignals'
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
import { securityChecklistForFiles } from '@main/integrations/securityGate'
import {
  benchmarkLearnings,
  deriveHeuristicLearnings,
  deriveModelStats,
  summarizeRetro,
  type BenchmarkRanking,
  type BenchmarkRecord,
  type BenchmarkRunStatus,
  type LearningKind,
  type ModelLearning,
  type RunRetro
} from '@shared/retro'
import {
  learningsForModel,
  recordBenchmarkRecord,
  recordModelLearnings,
  recordRunRetro
} from '@main/orchestrator/retroStore'
import { enqueueBenchmarkExport, enqueueRetroExport } from '@main/orchestrator/retroExport'
import { captureTaskRecoveryArtifact } from '@main/orchestrator/recoveryArtifact'

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
  deferPublish?: boolean
}

const RESULT_PREVIEW = 160
export function platformExecutionGuidance(
  platform: NodeJS.Platform = process.platform
): string[] {
  if (platform !== 'win32') return []
  return [
    'Windows/PowerShell: Nutze pro Tool-Aufruf einen kurzen Einzelbefehl.',
    "Windows/PowerShell: Nutze rg -g (z. B. rg -g '*.ts' Muster) statt Shell-Pfadglobs wie src/**/*.ts.",
    "Windows/PowerShell: rg mit Exit-Code 1 und leerem stderr bedeutet 'keine Treffer', nicht Infrastrukturfehler.",
    'Windows/PowerShell: Vereinfache nach Parser- oder Quotingfehlern den Aufruf; wiederhole ihn nicht unveraendert.'
  ]
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
  private goal: OrchestratorGoal | null = null
  private activity: OrchestratorActivity | undefined
  private readonly tasks = new Map<string, OrcaTask>()
  private readonly preparedChanges = new Map<string, PreparedTaskChange>()
  private readonly taskResults = new Map<string, string>()
  private readonly taskRuns = new Map<string, Promise<string>>()
  private readonly planRuns = new Map<string, Promise<ExecutionPlanResult>>()
  private readonly planRunResults = new Map<string, PlanRunStatusSnapshot>()
  private readonly planRunPlanIds = new Map<string, string>()
  private readonly reliability = initialReliability()
  private goalStartedAt?: number
  private taskSeq = 0
  private benchSeq = 0
  private lastRetro: RunRetro | undefined
  private readonly benchmarkRuns = new Map<
    string,
    { benchmarkId: string; title: string; prompt: string; taskIds: string[]; startedAt: number }
  >()
  private pendingPlan: PendingPlanReview | undefined
  private pendingPlanResolve: ((approved: boolean) => void) | undefined
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
    const restored = getSetting<OrchestratorSnapshot>(this.persistenceKey())
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
      const interrupted = task.status === 'queued' || task.status === 'running'
      this.tasks.set(task.id, {
        ...task,
        status: interrupted ? 'stopped' : task.status,
        note: interrupted ? 'Durch App-Neustart unterbrochen.' : task.note,
        finishedAt: interrupted ? Date.now() : task.finishedAt
      })
    }
  }

  private readonly limiters = new Map<string, Semaphore>()

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
        waitingTasks: tasks.filter((task) => task.status === 'queued').length
      },
      pendingPlan: this.pendingPlan,
      lastRetro: this.lastRetro
    }
  }

  private push(): void {
    this.reliability.lastSnapshotAt = Date.now()
    const snapshot = this.snapshot()
    try {
      setSetting(this.persistenceKey(), snapshot)
    } catch (error) {
      console.warn('[Orchestrator] snapshot persistence failed', error)
    }
    this.emit('snapshot', snapshot)
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
    const queued = tasks.filter((task) => task.status === 'queued')
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
    this.benchmarkRuns.clear()
    this.lastRetro = undefined
    this.push()
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
    this.pendingPlanResolve = undefined
    this.pendingPlan = undefined
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

  private requestPlanReview(review: PendingPlanReview): Promise<boolean> {
    if (this.pendingPlanResolve) throw new Error('Ein anderer Plan wartet bereits auf Review.')
    return new Promise<boolean>((resolve) => {
      this.pendingPlan = review
      this.pendingPlanResolve = resolve
      this.setActivityState(
        'awaiting-review',
        `Der Plan mit ${review.plan.tasks.length} Aufgabe(n) ist erstellt und wartet auf Freigabe.`,
        review.plan.tasks.slice(0, 4).map((task) => `${task.role}: ${task.title}`),
        'Nach Freigabe die DAG-Aufgaben gemäß Abhängigkeiten starten.'
      )
      this.push()
    })
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

  setGoal(title: string): void {
    this.goalStartedAt = Date.now()
    this.goal = { id: `epic-${Date.now().toString(36)}`, title, active: true }
    this.setActivityState(
      'planning',
      'Analysiert das Ziel und entscheidet, welche Teilaufgaben delegiert werden sollen.',
      [`Ziel: ${title}`],
      'Verfügbare Subagent-Rollen prüfen und den Ausführungsplan erstellen.'
    )
    this.push()
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
      const model = resolveModel(slot.provider, slot)
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
    const taskId = options.taskId ?? this.nextTaskId()
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
      model: resolveModel(slot.provider, slot),
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
      agentId: undefined,
      agentName: undefined,
      blocker: undefined,
      findings: undefined,
      failureKind: undefined,
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
    task.status = 'running'
    task.phase = 'preflight'
    task.lastAction = 'Pane-Preflight läuft'
    task.lastHeartbeatAt = Date.now()
    this.syncActivityFromTasks()
    this.push()

    const securityChecklist = securityChecklistForFiles(options.expectedFiles ?? [])
    const executionContract = [
      'Orca-Ausführungsvertrag:',
      '- Bearbeite nur die beauftragte Fachaufgabe und die erwarteten Dateien.',
      '- Führe relevante Tests, Typecheck und Lint aus.',
      '- Führe kein git add, commit, cherry-pick oder push aus; Orcas Main-Prozess sichert Änderungen zentral.',
      '- Bei Infrastrukturblockern antworte strukturiert und knapp: Blocker, Alternativen, geplante Dateien, Schnittstellen.',
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
    const rememberAction = (): void => {
      const action = task.lastAction?.trim()
      if (!action || task.recentActions?.[0] === action) return
      task.recentActions = [
        action,
        ...(task.recentActions ?? []).filter((entry) => entry !== action)
      ].slice(0, 3)
    }
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
      const wasCancelled = result.status === 'cancelled'
      const infrastructureFailure =
        result.failureKind === 'provider-auth' ||
        result.failureKind === 'sandbox' ||
        result.failureKind === 'stalled'
      task.status = wasCancelled ? 'stopped' : result.isError ? 'error' : 'success'
      task.failureKind = wasCancelled
        ? 'cancelled'
        : infrastructureFailure
          ? 'infrastructure'
          : result.isError ? 'worker' : undefined
      task.progress = task.status === 'success' ? 100 : undefined
      task.phase = task.status === 'success' ? 'completed' : task.phase
      task.lastAction = wasCancelled
        ? 'Manuell gestoppt'
        : infrastructureFailure
          ? 'Provider-Infrastruktur fehlgeschlagen' : result.isError ? 'Worker fehlgeschlagen' : 'Worker abgeschlossen'
      if (activeAttempt) {
        activeAttempt.status = task.status
        activeAttempt.failureKind = task.failureKind
        activeAttempt.finishedAt = Date.now()
        activeAttempt.note = result.result.replace(/\s+/g, ' ').trim().slice(0, RESULT_PREVIEW)
      }
      task.lastHeartbeatAt = Date.now()
      task.finishedAt = Date.now()
      const preview = result.result.replace(/\s+/g, ' ').trim().slice(0, RESULT_PREVIEW)
      task.note = result.isError ? 'Fehler bei der Ausführung' : preview
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
      if (result.isError && !wasCancelled) {
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
      if (!result.isError && !wasCancelled && autoPr) {
        task.phase = 'security-review'
        task.lastAction = 'Abnahme, Security und Commit-Vertrag laufen'
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
          if (this.reliability.timeToFirstUsefulCommitMs == null && this.goalStartedAt) {
            this.reliability.timeToFirstUsefulCommitMs = Date.now() - this.goalStartedAt
          }
          if (autoPr.mode !== 'off') this.preparedChanges.set(taskId, prepared.change)
        } else if (prepared.result === 'needs-work' && prepared.change) {
          task.status = 'needs-work'
          task.progress = undefined
          task.commit = prepared.change.commit
          task.completion = { kind: 'commit', commit: prepared.change.commit }
          task.findings = prepared.findings
          task.failureKind = 'gate'
          task.note = prepared.message
          task.lastAction = 'Partieller Commit gesichert · Gates benötigen Nacharbeit'
          this.reliability.needsWorkTasks += 1
          this.reliability.rescuedNeedsWorkCommits += 1
          if (activeAttempt) {
            activeAttempt.status = 'needs-work'
            activeAttempt.failureKind = 'gate'
            activeAttempt.note = prepared.message
          }
        } else if (prepared.result === 'no-changes') {
          task.completion = { kind: 'no-changes' }
        } else {
          task.status = 'error'
          task.progress = undefined
          task.note = (task.note || 'Worker fertig') + ' · Abnahme blockiert: ' + prepared.message
          task.lastAction = 'Commit-Vertrag oder Security-Gate fehlgeschlagen'
        }
        if (
          task.status === 'success' && autoPr.mode !== 'off' && !options.deferPublish &&
          !options.planId && prepared.change
        ) {
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
      if (task.status === 'error' && !result.isError) {
        return `${info.name} (${slotRole}) scheiterte an der Abnahme: ${task.note}`
      }
      const completion = task.completion?.kind === 'commit'
        ? `\n\nVerifizierter Commit: ${task.completion.commit}`
        : task.completion?.kind === 'no-changes' ? '\n\nVerifizierter Status: keine Änderungen' : ''
      const recoveryArtifact = task.recoveryArtifact
      const recovery = recoveryArtifact
        ? `\n\nRecovery-Artefakt: ${recoveryArtifact.worktree}\nDateien: ${recoveryArtifact.changedFiles.join(', ')}`
        : ''
      return result.isError
        ? `${info.name} (${slotRole}) meldete einen Fehler. Ausgabe:\n${result.result}${recovery}`
        : `${info.name} (${slotRole}) meldet:\n${result.result || '(kein Textergebnis)'}${completion}`
    } catch (err) {
      task.status = 'error'
      task.failureKind = 'infrastructure'
      task.phase = task.phase ?? 'preflight'
      task.lastAction = err instanceof PanePreflightError ? 'Pane-Preflight fehlgeschlagen' : 'Dispatch fehlgeschlagen'
      task.lastHeartbeatAt = Date.now()
      task.note = err instanceof Error ? err.message : String(err)
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
          model: resolveModel(slot.provider, slot),
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
      sem.release()
    }
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
      note: task.note
    }
  }

  listTaskStatuses(): TaskStatusSnapshot[] {
    return [...this.tasks.keys()].map((id) => this.getTaskStatus(id)!).filter(Boolean)
  }

  /**
   * Fan out several subtasks at once. They run in parallel (bounded by each
   * role's capacity) and all results are collected — the way to get real
   * parallelism instead of one blocking dispatch at a time.
   */
  async dispatchBatch(items: Array<{ role: string; prompt: string; title?: string }>): Promise<string> {
    const results = await Promise.all(
      items.map(async (it, i) => {
        const out = await this.dispatch(it.role, it.prompt, it.title, { deferPublish: true })
        return `#${i + 1} ${out}`
      })
    )
    await this.publishPendingChanges()
    return results.join('\n\n---\n\n')
  }
  /**
   * Validate and execute a model-authored DAG. The scheduler enforces global
   * concurrency, role capacity, dependencies and conflict keys.
   */
  async executePlan(input: unknown, runId?: string): Promise<ExecutionPlanResult> {
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
    this.setGoal(plan.goal)
    this.planSeq += 1
    const planId = `plan-${Date.now().toString(36)}-${this.planSeq.toString(36)}`
    if (runId) this.planRunPlanIds.set(runId, planId)
    const runtimeIds = new Map(
      plan.tasks.map((task) => [task.id, `${planId}-${task.id}`])
    )
    const requiredDependencies = (task: ExecutionPlanTask): string[] => task.dependsOn
    const advisoryDependencies = (task: ExecutionPlanTask): string[] => task.advisoryDependsOn
    const allDependencies = (task: ExecutionPlanTask): string[] =>
      [...requiredDependencies(task), ...advisoryDependencies(task)]

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
        model: resolveModel(selected.slot.provider, selected.slot),
        status: 'queued',
        phase: 'queued',
        criticality: planned.criticality,
        ownership: planned.ownership,
        note: planned.criticality === 'advisory' ? 'Advisory-Task' : undefined,
        lastAction: profile?.planner.mode === 'review'
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

    if (profile?.planner.mode === 'review') {
      const approved = await this.requestPlanReview({ planId, plan, validationIssues: resolved.issues })
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

    const stopTask = (task: ExecutionPlanTask, reason: string): void => {
      const runtimeId = runtimeIds.get(task.id)!
      const stopped = this.tasks.get(runtimeId)!
      Object.assign(stopped, {
        status: 'stopped' as const,
        failureKind: 'worker' as const,
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
            ? `# ${id} [${dependency.status}]\n${dependency.result}`
            : undefined
        })
        .filter(Boolean)
        .join('\n\n--- dependency ---\n\n')
      const taskPrompt = dependencyContext
        ? `${task.prompt}\n\nDependency results (use available commits/findings; advisory failures do not block):\n${dependencyContext}`
        : task.prompt
      const running = (async (): Promise<void> => {
        const maxRetries = profile?.planner.maxRetries ?? 1
        const attemptedRoles = new Set<string>()
        let requestedRole = task.role
        let recoveryContext = ''
        let recoveryWorktree: string | undefined

        for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
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
              maxAttempts: maxRetries + 1,
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
              findings: runtimeTask?.findings
            })
            return
          }

          if (attempt >= maxRetries) {
            results.set(task.id, {
              id: task.id,
              status: 'error',
              criticality: task.criticality,
              result: output,
              commit: runtimeTask?.commit,
              findings: runtimeTask?.findings
            })
            return
          }

          recoveryContext = output
          recoveryWorktree = runtimeTask?.recoveryArtifact?.worktree
          const alternatives = this.listSubagents()
            .filter((agent) => agent.available && !attemptedRoles.has(agent.role))
            .sort((a, b) => (a.busy / a.capacity) - (b.busy / b.capacity))
          if (profile?.planner.routingMode !== 'adaptive' || alternatives.length === 0) {
            results.set(task.id, {
              id: task.id,
              status: 'error',
              criticality: task.criticality,
              result: output,
              commit: runtimeTask?.commit,
              findings: runtimeTask?.findings
            })
            return
          }
          requestedRole = alternatives[0]!.role
          this.reliability.automaticRecoveries += 1
          this.setActivityState(
            'delegating',
            `Worker-/Pane-Fehler erkannt; Recovery ${attempt + 1}/${maxRetries} auf gesundem Slot.`,
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
            runtimeTask.lastAction = 'Plan-Dispatch unerwartet fehlgeschlagen'
            runtimeTask.finishedAt = Date.now()
          }
          results.set(task.id, {
            id: task.id,
            status: 'error',
            criticality: task.criticality,
            result: message
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

    await this.publishPendingChanges(planId)
    const planTasks = [...this.tasks.values()].filter((task) => task.planId === planId)
    const requiredTasks = planTasks.filter((task) => (task.criticality ?? 'required') === 'required')
    const requiredNeedsWork = requiredTasks.filter((task) => task.status === 'needs-work')
    const requiredErrors = requiredTasks.filter((task) => task.status === 'error')
    const requiredStopped = requiredTasks.filter((task) => task.status === 'stopped')
    const planStatus: ExecutionPlanResult['status'] = requiredNeedsWork.length > 0
      ? 'needs-work'
      : requiredErrors.length > 0
        ? 'error'
        : requiredStopped.length > 0
          ? 'stopped'
          : 'success'
    const attentionTasks = [...requiredNeedsWork, ...requiredErrors, ...requiredStopped]
    this.reliability.completedPlans += 1
    if (planStatus !== 'success') this.reliability.preventedFalseSuccesses += 1
    this.recordPlanRetro(planId, plan.goal, planStatus, planTasks)
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
      validationIssues: resolved.issues,
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

  private async publishPendingChanges(planId?: string): Promise<void> {
    const profile = this.activeProfile()
    if (!profile || profile.autoPr.mode === 'off') return
    const changes = [...this.preparedChanges.entries()]
      .filter(([taskId]) => {
        const task = this.tasks.get(taskId)
        return task?.autoPrStatus === 'prepared' && (planId == null || task.planId === planId)
      })
      .map(([, change]) => change)
    if (changes.length === 0) return

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
  ): void {
    try {
      const modelStats = deriveModelStats(planTasks)
      if (modelStats.length === 0) return
      const learnings = recordModelLearnings(
        deriveHeuristicLearnings(modelStats, { profileId: this.boundProfile?.id })
      )
      const retro: RunRetro = {
        id: `retro-${Date.now().toString(36)}-${planId}`,
        profileId: this.boundProfile?.id,
        workspaceSessionId: this.workspaceSessionId,
        planId,
        goal,
        status,
        summary: summarizeRetro(modelStats, status),
        modelStats,
        learnings,
        createdAt: Date.now()
      }
      recordRunRetro(retro)
      this.lastRetro = retro
      enqueueRetroExport(retro)
    } catch (error) {
      console.warn('[Orchestrator] Automatische Retro fehlgeschlagen', error)
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
    const applied = recordModelLearnings(
      input.learnings.map((learning) => ({
        ...learning,
        source: 'orchestrator' as const,
        profileId: this.boundProfile?.id
      }))
    )
    const summary = input.summary.replace(/\s+/g, ' ').trim().slice(0, 500)
    if (this.lastRetro) {
      const known = new Set(this.lastRetro.learnings.map((entry) => entry.id))
      this.lastRetro = {
        ...this.lastRetro,
        summary: summary || this.lastRetro.summary,
        learnings: [
          ...this.lastRetro.learnings,
          ...applied.filter((entry) => !known.has(entry.id))
        ]
      }
      recordRunRetro(this.lastRetro)
      enqueueRetroExport(this.lastRetro)
    } else {
      this.lastRetro = {
        id: `retro-${Date.now().toString(36)}-adhoc`,
        profileId: this.boundProfile?.id,
        workspaceSessionId: this.workspaceSessionId,
        planId: 'ad-hoc',
        goal: this.goal?.title ?? '',
        summary: summary || 'Retro ohne Planlauf aufgezeichnet.',
        modelStats: deriveModelStats([...this.tasks.values()]),
        learnings: applied,
        createdAt: Date.now()
      }
      recordRunRetro(this.lastRetro)
      enqueueRetroExport(this.lastRetro)
    }
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
      entries.slice(0, 4).map(({ slot, role }) => `${role}: ${slot.provider}/${resolveModel(slot.provider, slot) || 'Standard'}`),
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
    const runId = `plan-run-${Date.now().toString(36)}-${(this.planSeq + 1).toString(36)}`
    const initial: PlanRunStatusSnapshot = {
      runId,
      status: 'running',
      engineId: this.engineId,
      workspaceSessionId: this.workspaceSessionId,
      goal: this.goal?.title
    }
    this.planRunResults.set(runId, initial)
    const run = this.executePlan(input, runId)
      .then((result) => {
        this.planRunResults.set(runId, {
          ...initial,
          status: result.status,
          planId: result.planId,
          result
        })
        return result
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error)
        this.planRunResults.set(runId, { ...initial, status: 'error', error: message })
        throw error
      })
    this.planRuns.set(runId, run)
    void run.catch(() => undefined).finally(() => this.planRuns.delete(runId))
    return initial
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
      goal: this.goal?.title,
      tasks,
      summary: {
        required: tasks.filter((task) => (task.criticality ?? 'required') === 'required').length,
        advisory: tasks.filter((task) => task.criticality === 'advisory').length,
        running: tasks.filter((task) => task.status === 'queued' || task.status === 'running').length,
        succeeded: tasks.filter((task) => task.status === 'success').length,
        needsWork: tasks.filter((task) => task.status === 'needs-work').length,
        failed: tasks.filter((task) => task.status === 'error' || task.status === 'stopped').length
      }
    }
  }

  /** Open a persistent interactive subagent in its own OS window. */
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
