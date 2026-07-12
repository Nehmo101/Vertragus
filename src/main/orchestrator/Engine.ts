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
  SubagentDescriptor
} from '@shared/orchestrator'
import type { AgentSlot, WorkspaceProfile } from '@shared/profile'
import { agentManager } from '@main/agents/AgentManager'
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
  type PreparedTaskChange
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
  private taskSeq = 0
  private pendingPlan: PendingPlanReview | undefined
  private pendingPlanResolve: ((approved: boolean) => void) | undefined
  /** Per-role capacity limiter — count = max parallel subagents of that role. */
  private boundProfile: WorkspaceProfile | undefined

  constructor() {
    super()
    const restored = getSetting<OrchestratorSnapshot>('orchestratorSnapshot')
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
    return {
      goal: this.goal,
      tasks: [...this.tasks.values()].sort((a, b) => a.createdAt - b.createdAt),
      pendingPlan: this.pendingPlan
    }
  }

  private push(): void {
    const snapshot = this.snapshot()
    try {
      setSetting('orchestratorSnapshot', snapshot)
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
    this.boundProfile = undefined
    this.push()
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
  activate(): void {
    const profile = getProfile(getActiveProfileId())
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

  /** Slots the orchestrator is allowed to dispatch to. */
  private dispatchableSlots(): AgentSlot[] {
    const profile = this.activeProfile()
    const slots = (profile?.agents ?? []).filter((s) => s.orchestrated)
    if (slots.length > 0) return slots
    // Fallback so the orchestrator always has somewhere to dispatch.
    return [{ role: 'worker', provider: 'codex', model: '', count: 3, orchestrated: true, yolo: false }]
  }

  /**
   * Assign each slot a UNIQUE role the orchestrator can target. Slots often
   * share the default role "worker" (or none), which would make them
   * indistinguishable; fall back to the provider name and suffix duplicates.
   */
  private slotsWithRoles(): Array<{ slot: AgentSlot; role: string }> {
    const seen = new Map<string, number>()
    return this.dispatchableSlots().map((slot) => {
      const base = (slot.role?.trim() || slot.provider).toLowerCase()
      const n = seen.get(base) ?? 0
      seen.set(base, n + 1)
      return { slot, role: n === 0 ? base : `${base}-${n + 1}` }
    })
  }

  listSubagents(): SubagentDescriptor[] {
    return this.slotsWithRoles().map(({ slot, role }) => ({
      role,
      provider: slot.provider,
      model: slot.model,
      capacity: slot.count,
      busy: this.limiters.get(role)?.inUse ?? 0
    }))
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
    this.taskSeq += 1
    const taskId = options.taskId ?? `t-${this.taskSeq.toString(36)}`
    const yolo = slot.yolo || (profile?.yoloDefault ?? false)

    const task: OrcaTask = {
      id: taskId,
      title: title?.trim() || prompt.split('\n')[0].slice(0, 60),
      role: slotRole,
      provider: slot.provider,
      model: slot.model,
      status: 'queued',
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
    this.push()

    const subSystemPrompt =
      'Du bist ein Subagent in Orca-Strator, beauftragt vom Orchestrator. ' +
      'Erledige die Aufgabe eigenständig und fasse das Ergebnis am Ende knapp zusammen.'

    try {
      const { info, done } = await agentManager.runTask({
        provider: slot.provider,
        model: slot.model,
        role: slotRole,
        taskId,
        prompt,
        systemPrompt: subSystemPrompt,
        yolo,
        workingDir: slot.workingDir || profile?.workingDir,
        timeoutMs: (profile?.planner.taskTimeoutMinutes ?? 30) * 60_000
      })
      task.agentId = info.id
      task.agentName = info.name
      this.push()

      const result = await done
      const wasCancelled = result.status === 'cancelled'
      task.status = wasCancelled ? 'stopped' : result.isError ? 'error' : 'success'
      task.progress = task.status === 'success' ? 100 : undefined
      task.finishedAt = Date.now()
      const preview = result.result.replace(/\s+/g, ' ').trim().slice(0, RESULT_PREVIEW)
      task.note = result.isError ? 'Fehler bei der Ausführung' : preview
      task.worktree = info.worktree
      const autoPr = profile?.autoPr
      if (!result.isError && autoPr && autoPr.mode !== 'off') {
        const prepared = await prepareTaskChange({
          config: autoPr,
          taskId,
          title: task.title,
          worktree: info.worktree
        })
        task.autoPrStatus = prepared.status
        task.branch = prepared.branch
        task.commit = prepared.change?.commit
        if (prepared.change) this.preparedChanges.set(taskId, prepared.change)
        if (prepared.status === 'blocked') {
          task.note = `${task.note || 'Task fertig'} · Auto-PR blockiert: ${prepared.message}`
        }
        if (!options.deferPublish && !options.planId && prepared.change) {
          await this.publishPendingChanges()
        }
      }
      this.push()

      if (wasCancelled) return `${info.name} (${slotRole}) stopped.`
      return result.isError
        ? `${info.name} (${slotRole}) meldete einen Fehler. Ausgabe:\n${result.result}`
        : `${info.name} (${slotRole}) meldet:\n${result.result || '(kein Textergebnis)'}`
    } catch (err) {
      task.status = 'error'
      task.note = err instanceof Error ? err.message : String(err)
      task.finishedAt = Date.now()
      this.push()
      return `Dispatch fehlgeschlagen: ${task.note}`
    } finally {
      sem.release()
    }
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
            model: selected.slot.model,
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
        model: selected.slot.model,
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
      const running = this.dispatch(task.role, task.prompt, task.title, {
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

    const outcome = await publishPreparedChanges({
      config: profile.autoPr,
      goalId: this.goal?.id ?? planId ?? 'goal',
      goalTitle: this.goal?.title ?? 'Orca-Strator Aufgabe',
      changes
    })
    const changedCommits = new Set(changes.map((change) => change.commit))
    for (const task of this.tasks.values()) {
      if (!task.commit || !changedCommits.has(task.commit)) continue
      task.autoPrStatus = outcome.status
      task.prUrl = outcome.url
      if (outcome.status === 'blocked') {
        task.note = `${task.note || 'Task fertig'} · Auto-PR blockiert: ${outcome.message}`
      }
      this.preparedChanges.delete(task.id)
    }
    this.push()
  }


  /** Open a persistent interactive subagent in its own OS window. */
  async openSubwindow(role: string, prompt?: string): Promise<string> {
    const { slot, role: slotRole } = this.pickSlot(role)
    const profile = this.activeProfile()
    const info = await agentManager.spawn({
      provider: slot.provider,
      model: slot.model,
      role: `Subagent · ${slotRole}`,
      kind: 'sub',
      yolo: slot.yolo || (profile?.yoloDefault ?? false),
      workingDir: slot.workingDir || profile?.workingDir
    })
    createPaneWindow(info.id)
    if (prompt) {
      // Give the interactive CLI a moment to boot before feeding the prompt.
      setTimeout(() => agentManager.write(info.id, prompt + '\r'), 1500)
    }
    return info.id
  }
}

export const orchestratorEngine = new OrchestratorEngine()
