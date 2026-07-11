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
  OrcaTask,
  OrchestratorGoal,
  OrchestratorSnapshot,
  SubagentDescriptor
} from '@shared/orchestrator'
import type { AgentSlot, WorkspaceProfile } from '@shared/profile'
import { agentManager } from '@main/agents/AgentManager'
import { getProfile, getActiveProfileId } from '@main/config/store'
import { createPaneWindow } from '@main/windows'
import { Semaphore } from '@main/orchestrator/semaphore'

const RESULT_PREVIEW = 160

export class OrchestratorEngine extends EventEmitter {
  private goal: OrchestratorGoal | null = null
  private readonly tasks = new Map<string, OrcaTask>()
  private taskSeq = 0
  /** Per-role capacity limiter — count = max parallel subagents of that role. */
  private readonly limiters = new Map<string, Semaphore>()

  snapshot(): OrchestratorSnapshot {
    return {
      goal: this.goal,
      tasks: [...this.tasks.values()].sort((a, b) => a.createdAt - b.createdAt)
    }
  }

  private push(): void {
    this.emit('snapshot', this.snapshot())
  }

  reset(): void {
    this.goal = null
    this.tasks.clear()
    this.limiters.clear()
    this.push()
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
    if (!this.goal) this.goal = { id: 'goal', title: 'Orchestrator aktiv', active: true }
    else this.goal.active = true
    this.push()
  }

  setGoal(title: string): void {
    this.goal = { id: `epic-${Date.now().toString(36)}`, title, active: true }
    this.push()
  }

  private activeProfile(): WorkspaceProfile | undefined {
    return getProfile(getActiveProfileId())
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
  async dispatch(role: string, prompt: string, title?: string): Promise<string> {
    const { slot, role: slotRole } = this.pickSlot(role)
    const profile = this.activeProfile()
    this.taskSeq += 1
    const taskId = `t-${this.taskSeq.toString(36)}`
    const yolo = slot.yolo || (profile?.yoloDefault ?? false)

    const task: OrcaTask = {
      id: taskId,
      title: title?.trim() || prompt.split('\n')[0].slice(0, 60),
      role: slotRole,
      provider: slot.provider,
      model: slot.model,
      status: 'queued',
      yolo,
      createdAt: Date.now()
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
        workingDir: slot.workingDir || profile?.workingDir
      })
      task.agentId = info.id
      task.agentName = info.name
      this.push()

      const result = await done
      task.status = result.isError ? 'error' : 'success'
      task.progress = result.isError ? undefined : 100
      task.finishedAt = Date.now()
      const preview = result.result.replace(/\s+/g, ' ').trim().slice(0, RESULT_PREVIEW)
      task.note = result.isError ? 'Fehler bei der Ausführung' : preview
      this.push()

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
        const out = await this.dispatch(it.role, it.prompt, it.title)
        return `#${i + 1} ${out}`
      })
    )
    return results.join('\n\n---\n\n')
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
