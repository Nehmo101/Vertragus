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
import type {
  ExecutionPlanResult,
  ExecutionPlanTask,
  ExecutionPlanTaskResult,
  OrcaTask,
  OrchestratorGoal,
  PendingPlanReview,
  OrchestratorSnapshot,
  PlanRunStatusSnapshot,
  SubagentDescriptor,
  TaskStatusSnapshot
} from '@shared/orchestrator'
import {
  agentSlotsWithRoles,
  profileDefaultBaseBranch,
  type AgentSlot,
  type WorkspaceProfile
} from '@shared/profile'
import { resolveModel } from '@shared/models'
import { agentManager } from '@main/agents/AgentManager'
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

interface DispatchOptions {
  taskId?: string
  planId?: string
  dependsOn?: string[]
  conflictKeys?: string[]
  deferPublish?: boolean
}

const RESULT_PREVIEW = 160

export class OrchestratorEngine extends EventEmitter {
  private planSeq = 0
  private goal: OrchestratorGoal | null = null
  private readonly tasks = new Map<string, OrcaTask>()
  private readonly preparedChanges = new Map<string, PreparedTaskChange>()
  private readonly taskResults = new Map<string, string>()
  private readonly taskRuns = new Map<string, Promise<string>>()
  private readonly planRuns = new Map<string, Promise<ExecutionPlanResult>>()
  private readonly planRunResults = new Map<string, PlanRunStatusSnapshot>()
  private taskSeq = 0
  private pendingPlan: PendingPlanReview | undefined
  private pendingPlanResolve: ((approved: boolean) => void) | undefined
  /** Per-role capacity limiter — count = max parallel subagents of that role. */
  private boundProfile: WorkspaceProfile | undefined
  private readonly workspaceSessionId: string | undefined

  constructor(options: { profile?: WorkspaceProfile; workspaceSessionId?: string } = {}) {
    super()
    this.boundProfile = options.profile
      ? { ...options.profile, agents: options.profile.agents.map((slot) => ({ ...slot })) }
      : undefined
    this.workspaceSessionId = options.workspaceSessionId
    const restored = getSetting<OrchestratorSnapshot>(this.persistenceKey())
    if (!restored || !Array.isArray(restored.tasks)) return
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
    const warmInteractiveAgents = agents.filter((agent) =>
      agent.mode === 'interactive' && agent.kind === 'sub' && agent.status !== 'stopped' &&
      agent.status !== 'error' && (!profile?.id || agent.profileId === profile.id)
    ).length
    return {
      profileId: this.boundProfile?.id,
      workspaceSessionId: this.workspaceSessionId,
      goal: this.goal,
      tasks,
      capacity: {
        warmInteractiveAgents,
        maxTaskParallelism: profile?.planner.maxParallel ?? 1,
        configuredRoleCapacity: this.slotsWithRoles().reduce((sum, entry) => sum + entry.slot.count, 0),
        activeTasks: tasks.filter((task) => task.status === 'running').length,
        waitingTasks: tasks.filter((task) => task.status === 'queued').length
      },
      pendingPlan: this.pendingPlan
    }
  }

  private push(): void {
    const snapshot = this.snapshot()
    try {
      setSetting(this.persistenceKey(), snapshot)
    } catch (error) {
      console.warn('[Orchestrator] snapshot persistence failed', error)
    }
    this.emit('snapshot', snapshot)
  }

  reset(): void {
    this.pendingPlanResolve?.(false)
    this.pendingPlanResolve = undefined
    this.pendingPlan = undefined
    this.goal = null
    this.tasks.clear()
    this.limiters.clear()
    this.preparedChanges.clear()
    this.taskResults.clear()
    this.taskRuns.clear()
    this.planRuns.clear()
    this.planRunResults.clear()
    this.push()
  }

  private persistenceKey(): string {
    return this.boundProfile?.id
      ? `orchestratorSnapshot:${this.boundProfile.id}`
      : 'orchestratorSnapshot'
  }

  reviewPlan(approved: boolean): boolean {
    const resolve = this.pendingPlanResolve
    if (!resolve) return false
    this.pendingPlanResolve = undefined
    this.pendingPlan = undefined
    this.push()
    resolve(approved)
    return true
  }

  private requestPlanReview(review: PendingPlanReview): Promise<boolean> {
    if (this.pendingPlanResolve) throw new Error('Ein anderer Plan wartet bereits auf Review.')
    return new Promise<boolean>((resolve) => {
      this.pendingPlan = review
      this.pendingPlanResolve = resolve
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
    this.push()
  }

  setGoal(title: string): void {
    this.goal = { id: `epic-${Date.now().toString(36)}`, title, active: true }
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
    const configured = agentSlotsWithRoles(this.activeProfile()?.agents ?? []).filter(
      ({ slot }) => slot.orchestrated
    )
    if (configured.length > 0) return configured
    // Fallback so the orchestrator always has somewhere to dispatch.
    return agentSlotsWithRoles([
      { role: 'worker', provider: 'codex', model: '', count: 3, orchestrated: true, yolo: false }
    ])
  }

  listSubagents(): SubagentDescriptor[] {
    return this.slotsWithRoles().map(({ slot, role }) => ({
      role,
      provider: slot.provider,
      model: resolveModel(slot.provider, slot),
      capacity: slot.count,
      busy: this.limiters.get(role)?.inUse ?? 0
    }))
  }

  private nextTaskId(): string {
    this.taskSeq += 1
    return `t-${this.taskSeq.toString(36)}`
  }

  private pickSlot(role: string): { slot: AgentSlot; role: string } {
    const entries = this.slotsWithRoles()
    const q = role.trim().toLowerCase()
    return (
      entries.find((e) => e.role === q) ??
      entries.find((e) => e.slot.provider === q) ??
      entries.find((e) => e.role.includes(q) || q.includes(e.role)) ??
      entries[0]
    )
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

    const task: OrcaTask = {
      id: taskId,
      title: title?.trim() || prompt.split('\n')[0].slice(0, 60),
      role: slotRole,
      provider: slot.provider,
      model: resolveModel(slot.provider, slot),
      status: 'queued',
      phase: 'queued',
      lastAction: 'Wartet auf freie Kapazität',
      lastHeartbeatAt: Date.now(),
      yolo,
      createdAt: Date.now(),
      dependsOn: options.dependsOn,
      conflictKeys: options.conflictKeys,
      planId: options.planId
    }
    this.tasks.set(taskId, task)
    this.push()

    const sem = this.limiter(slotRole, slot.count)
    await sem.acquire()
    task.status = 'running'
    task.phase = 'starting'
    task.lastAction = 'Worker wird gestartet'
    task.lastHeartbeatAt = Date.now()
    this.push()

    const subSystemPrompt =
      'Du bist ein namentlich gekennzeichneter Subagent in Orca-Strator, beauftragt vom Orchestrator. ' +
      'Erledige die Aufgabe eigenständig und fasse das Ergebnis am Ende knapp zusammen.'

    let lastLifecyclePush = 0
    const onLifecycleEvent = (event: import('@main/agents/headless').HeadlessLifecycleEvent): void => {
      task.lastHeartbeatAt = event.timestamp
      if (event.type === 'phase') task.lastAction = `Worker-Phase: ${event.phase}`
      if (event.type === 'heartbeat') task.lastAction = `Worker aktiv · ${Math.round(event.idleMs / 1000)}s ohne Ausgabe`
      if (event.type === 'progress') task.lastAction = `Provider-Fortschritt: ${event.providerEvent}`
      if (event.type === 'output') {
        const clean = stripAnsi(event.chunk).replace(/\s+/g, ' ').trim()
        if (clean) task.lastAction = clean.slice(-RESULT_PREVIEW)
        if (/\b(test|vitest|typecheck|lint|pytest|cargo test)\b/i.test(clean)) task.phase = 'testing'
        else if (/\b(git commit|committ(?:ing|ed)?)\b/i.test(clean)) task.phase = 'committing'
        else if (task.phase === 'starting') task.phase = 'working'
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
        prompt,
        systemPrompt: subSystemPrompt,
        yolo,
        workingDir: slot.workingDir || profile?.workingDir,
        profileId: profile?.id,
        workspaceSessionId: this.workspaceSessionId
      }, { onEvent: onLifecycleEvent, heartbeatIntervalMs: 45_000 })
      task.agentId = info.id
      task.agentName = info.name
      task.phase = 'working'
      task.lastAction = 'Worker arbeitet'
      task.lastHeartbeatAt = Date.now()
      this.push()

      const result = await done
      const wasCancelled = result.status === 'cancelled'
      task.status = wasCancelled ? 'stopped' : result.isError ? 'error' : 'success'
      task.progress = task.status === 'success' ? 100 : undefined
      task.phase = task.status === 'success' ? 'completed' : task.phase
      task.lastAction = wasCancelled ? 'Manuell gestoppt' : result.isError ? 'Worker fehlgeschlagen' : 'Worker abgeschlossen'
      task.lastHeartbeatAt = Date.now()
      task.finishedAt = Date.now()
      const preview = result.result.replace(/\s+/g, ' ').trim().slice(0, RESULT_PREVIEW)
      task.note = result.isError ? 'Fehler bei der Ausführung' : preview
      task.worktree = info.worktree
      const autoPr = profile?.autoPr
      if (!result.isError && !wasCancelled && autoPr) {
        task.phase = 'security-review'
        task.lastAction = 'Abnahme, Security und Commit-Vertrag laufen'
        task.lastHeartbeatAt = Date.now()
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
          if (autoPr.mode !== 'off') this.preparedChanges.set(taskId, prepared.change)
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
      this.push()

      if (wasCancelled) return `${info.name} (${slotRole}) stopped.`
      if (task.status === 'error' && !result.isError) {
        return `${info.name} (${slotRole}) scheiterte an der Abnahme: ${task.note}`
      }
      const completion = task.completion?.kind === 'commit'
        ? `\n\nVerifizierter Commit: ${task.completion.commit}`
        : task.completion?.kind === 'no-changes' ? '\n\nVerifizierter Status: keine Änderungen' : ''
      return result.isError
        ? `${info.name} (${slotRole}) meldete einen Fehler. Ausgabe:\n${result.result}`
        : `${info.name} (${slotRole}) meldet:\n${result.result || '(kein Textergebnis)'}${completion}`
    } catch (err) {
      task.status = 'error'
      task.phase = task.phase ?? 'starting'
      task.lastAction = 'Dispatch fehlgeschlagen'
      task.lastHeartbeatAt = Date.now()
      task.note = err instanceof Error ? err.message : String(err)
      task.finishedAt = Date.now()
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
      (task.status === 'success' || task.status === 'error' || task.status === 'stopped')
      ? 'running'
      : task.status
    return {
      taskId, title: task.title, role: task.role, agentId: task.agentId, agentName: task.agentName,
      provider: task.provider, model: task.model, status, phase: task.phase, progress: task.progress,
      lastAction: task.lastAction, lastHeartbeatAt: task.lastHeartbeatAt, completion: task.completion,
      result: task.status === 'success' || task.status === 'stopped' ? result : undefined,
      error: task.status === 'error' ? result ?? task.note : undefined, note: task.note
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
  async executePlan(input: unknown): Promise<ExecutionPlanResult> {
    const profile = this.activeProfile()
    if (profile?.planner.mode === 'manual') {
      throw new Error('Auto-Planung ist für dieses Profil deaktiviert.')
    }
    const subagents = this.listSubagents()
    const defaultRole = subagents[0]?.role ?? 'worker'
    const resolved = resolveExecutionPlan(
      input, defaultRole, undefined, subagents.map((agent) => agent.role)
    )
    const configuredLimit = profile?.planner.maxParallel ?? resolved.plan.maxParallel
    const plan = { ...resolved.plan, maxParallel: Math.min(resolved.plan.maxParallel, configuredLimit) }
    this.setGoal(plan.goal)
    this.planSeq += 1
    const planId = `plan-${Date.now().toString(36)}-${this.planSeq.toString(36)}`
    const runtimeIds = new Map(
      plan.tasks.map((task) => [task.id, `${planId}-${task.id}`])
    )
    if (profile?.planner.mode === 'review') {
      const approved = await this.requestPlanReview({ planId, plan, validationIssues: resolved.issues })
      if (!approved) {
        const reason = 'Plan wurde im Review abgelehnt.'
        for (const planned of plan.tasks) {
          const selected = this.pickSlot(planned.role)
          const runtimeId = runtimeIds.get(planned.id)!
          this.tasks.set(runtimeId, {
            id: runtimeId,
            title: planned.title,
            role: selected.role,
            provider: selected.slot.provider,
            model: resolveModel(selected.slot.provider, selected.slot),
            status: 'stopped',
            note: reason,
            planId,
            createdAt: Date.now(),
            finishedAt: Date.now()
          })
        }
        this.push()
        return {
          planId,
          usedFallback: resolved.usedFallback,
          validationIssues: resolved.issues,
          tasks: plan.tasks.map((task) => ({ id: task.id, status: 'stopped', result: reason }))
        }
      }
    }
    const pending = new Map(plan.tasks.map((task) => [task.id, task]))
    const active = new Map<string, Promise<void>>()
    const activeConflicts = new Set<string>()
    const results = new Map<string, ExecutionPlanTaskResult>()

    const stopTask = (task: ExecutionPlanTask, reason: string): void => {
      const runtimeId = runtimeIds.get(task.id)!
      const selected = this.pickSlot(task.role)
      const stopped: OrcaTask = {
        id: runtimeId,
        title: task.title,
        role: selected.role,
        provider: selected.slot.provider,
        model: resolveModel(selected.slot.provider, selected.slot),
        status: 'stopped',
        note: reason,
        dependsOn: task.dependsOn.map((id) => runtimeIds.get(id)!),
        conflictKeys: task.conflictKeys,
        planId,
        createdAt: Date.now(),
        finishedAt: Date.now()
      }
      this.tasks.set(runtimeId, stopped)
      results.set(task.id, { id: task.id, status: 'stopped', result: reason })
      pending.delete(task.id)
      this.push()
    }

    const startTask = (task: ExecutionPlanTask): void => {
      pending.delete(task.id)
      for (const key of task.conflictKeys) activeConflicts.add(key)
      const runtimeId = runtimeIds.get(task.id)!
      const dependencyContext = task.ownership === 'integrator'
        ? task.dependsOn.map((id) => results.get(id)?.result).filter(Boolean).join('\n\n--- dependency ---\n\n')
        : ''
      const taskPrompt = dependencyContext
        ? `${task.prompt}\n\nDependency results (commits and integration notes):\n${dependencyContext}`
        : task.prompt
      const running = this.dispatch(task.role, taskPrompt, task.title, {
        taskId: runtimeId,
        planId,
        dependsOn: task.dependsOn.map((id) => runtimeIds.get(id)!),
        conflictKeys: task.conflictKeys
      })
        .then((output) => {
          const runtimeTask = this.tasks.get(runtimeId)
          const status = runtimeTask?.status === 'success'
            ? 'success' : runtimeTask?.status === 'stopped' ? 'stopped' : 'error'
          results.set(task.id, { id: task.id, status, result: output })
        })
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error)
          results.set(task.id, { id: task.id, status: 'error', result: message })
        })
        .finally(() => {
          active.delete(task.id)
          for (const key of task.conflictKeys) activeConflicts.delete(key)
        })
      active.set(task.id, running)
    }

    while (pending.size > 0 || active.size > 0) {
      // A failed prerequisite stops its downstream nodes without spawning CLIs.
      let stoppedOne: boolean
      do {
        stoppedOne = false
        for (const task of [...pending.values()]) {
          const failedDependency = task.dependsOn.find((dependency) => {
            const result = results.get(dependency)
            return result && result.status !== 'success'
          })
          if (failedDependency) {
            stopTask(task, `Abhaengigkeit ${failedDependency} ist fehlgeschlagen.`)
            stoppedOne = true
          }
        }
      } while (stoppedOne)

      while (active.size < plan.maxParallel) {
        const next = [...pending.values()].find(
          (task) =>
            task.dependsOn.every((dependency) => results.get(dependency)?.status === 'success') &&
            task.conflictKeys.every((key) => !activeConflicts.has(key))
        )
        if (!next) break
        startTask(next)
      }

      if (active.size === 0 && pending.size > 0) {
        // Validation should make this unreachable; keep the runtime fail-closed.
        for (const task of [...pending.values()]) {
          stopTask(task, 'Scheduler konnte keinen sicheren naechsten Task bestimmen.')
        }
        break
      }
      if (active.size > 0) await Promise.race(active.values())
    }
    await this.publishPendingChanges(planId)

    return {
      planId,
      usedFallback: resolved.usedFallback,
      validationIssues: resolved.issues,
      tasks: plan.tasks.map(
        (task) =>
          results.get(task.id) ?? {
            id: task.id,
            status: 'stopped',
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
      this.push()
    }

    this.tasks.set(integrationId, integrationTask)
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
    this.push()
  }


  /** Start a complete DAG without keeping the MCP request open. */
  executePlanAsync(input: unknown): PlanRunStatusSnapshot {
    const runId = `plan-run-${Date.now().toString(36)}-${(this.planSeq + 1).toString(36)}`
    this.planRunResults.set(runId, { runId, status: 'running' })
    const run = this.executePlan(input)
      .then((result) => { this.planRunResults.set(runId, { runId, status: 'success', result }); return result })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error)
        this.planRunResults.set(runId, { runId, status: 'error', error: message })
        throw error
      })
    this.planRuns.set(runId, run)
    void run.catch(() => undefined).finally(() => this.planRuns.delete(runId))
    return { runId, status: 'running' }
  }

  getPlanRunStatus(runId: string): PlanRunStatusSnapshot | undefined {
    return this.planRunResults.get(runId)
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
      workspaceSessionId: this.workspaceSessionId
    })
    createPaneWindow(info.id)
    if (prompt) {
      void agentManager.seedInteractive(info.id, prompt)
    }
    return info.id
  }
}

export const orchestratorEngine = new OrchestratorEngine()
