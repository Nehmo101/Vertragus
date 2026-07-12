/**
 * AgentManager — owns the lifecycle of every running agent instance.
 *
 * Each agent is a real PTY process (@lydell/node-pty, prebuilt N-API) running
 * the provider's interactive CLI. Output is broadcast to every renderer
 * window; a ring buffer allows late-mounting terminals (pop-outs, reloads)
 * to replay scrollback.
 */
import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { execFile } from 'node:child_process'
import * as pty from '@lydell/node-pty'
import type { AgentInstanceInfo, OrcaEvent, SpawnAgentRequest } from '@shared/agents'
import type { AgentProviderId } from '@shared/providers'
import { buildInteractiveLaunch } from '@main/providers/types'
import { resolveLaunch } from '@main/agents/resolveCommand'
import { createWorktree } from '@main/agents/worktree'
import { getSetting } from '@main/config/store'
import { runHeadless, type HeadlessHandle, type HeadlessResult } from '@main/agents/headless'
import { buildOrchestratorSetup } from '@main/orchestrator/orchestratorLaunch'
import { NameAllocator } from '@main/agents/names'

const BUFFER_LIMIT = 200_000 // chars of scrollback kept per agent

interface Managed {
  info: AgentInstanceInfo
  pty?: pty.IPty
  headless?: HeadlessHandle
  buffer: string
  seq: number
}

export interface RunTaskRequest {
  provider: AgentProviderId
  model: string
  role: string
  taskId: string
  prompt: string
  systemPrompt?: string
  yolo: boolean
  workingDir?: string
  timeoutMs?: number
}

export class AgentManager extends EventEmitter {
  private readonly agents = new Map<string, Managed>()
  private readonly names = new NameAllocator()
  private readonly sessionId = randomUUID()
  private seq = 0

  list(): AgentInstanceInfo[] {
    return [...this.agents.values()].map((m) => m.info)
  }

  buffer(id: string): { data: string; seq: number } {
    const m = this.agents.get(id)
    return { data: m?.buffer ?? '', seq: m?.seq ?? 0 }
  }

  private emitEvent(text: string, tone: OrcaEvent['tone'] = 'info'): void {
    const evt: OrcaEvent = { time: Date.now(), text, tone }
    this.emit('event', evt)
  }

  private changed(): void {
    this.emit('changed', this.list())
  }

  private nextId(prefix: string): string {
    this.seq += 1
    return `${prefix}-${String(this.seq).padStart(2, '0')}`
  }

  /** Resolve the effective working dir, creating an isolated worktree if enabled. */
  private async prepareWorkingDir(
    id: string,
    requested: string | undefined
  ): Promise<{ workingDir: string; worktree?: string }> {
    let workingDir = requested?.trim() || homedir()
    let worktree: string | undefined
    const isolate = getSetting<boolean>('worktreeIsolation') ?? true
    if (isolate) {
      const wt = await createWorktree(workingDir, id, this.sessionId)
      if (wt) {
        workingDir = wt.path
        worktree = wt.path
        this.emitEvent(`${id} worktree ${wt.branch} @ ${wt.path}`, 'muted')
      }
    }
    return { workingDir, worktree }
  }

  private pushData(managed: Managed, data: string): void {
    managed.buffer = (managed.buffer + data).slice(-BUFFER_LIMIT)
    managed.seq += 1
    this.emit('data', { id: managed.info.id, data, seq: managed.seq })
  }

  async spawn(req: SpawnAgentRequest): Promise<AgentInstanceInfo> {
    const kind = req.kind ?? 'sub'
    const id = this.nextId(kind === 'orchestrator' ? 'orch' : 'sub')
    const name = this.names.allocate(kind)
    const yolo = req.yolo ?? false
    const { workingDir, worktree } = await this.prepareWorkingDir(id, req.workingDir)

    // Orchestrators get the Orca MCP server + orchestrator system prompt.
    const orchestratorSetup =
      kind === 'orchestrator' ? buildOrchestratorSetup(req.provider, name) : undefined
    if (orchestratorSetup && !orchestratorSetup.capability.supported) {
      throw new Error(orchestratorSetup.capability.reason ?? `${req.provider} cannot orchestrate.`)
    }
    const orchestratorArgs = orchestratorSetup?.extraArgs ?? []

    const launch = buildInteractiveLaunch(req.provider, {
      model: req.model,
      workingDir,
      yolo,
      extraArgs: orchestratorArgs
    })
    const resolved = await resolveLaunch(launch.command, launch.args)

    const info: AgentInstanceInfo = {
      id,
      name,
      provider: req.provider,
      model: req.model,
      role: req.role ?? (kind === 'orchestrator' ? 'Orchestrator · plant & verteilt' : 'Subagent'),
      kind,
      mode: 'interactive',
      yolo,
      workingDir,
      worktree,
      status: 'running',
      startedAt: Date.now()
    }
    const managed: Managed = { info, buffer: '', seq: 0 }
    this.agents.set(id, managed)

    try {
      const proc = pty.spawn(resolved.file, resolved.args, {
        name: 'xterm-256color',
        cols: 100,
        rows: 30,
        cwd: workingDir,
        env: { ...process.env } as Record<string, string>
      })
      managed.pty = proc
      info.pid = proc.pid

      proc.onData((data) => this.pushData(managed, data))
      proc.onExit(({ exitCode }) => {
        managed.pty = undefined
        if (!this.agents.has(id)) return // killed & removed explicitly
        info.exitCode = exitCode
        info.status = exitCode === 0 ? 'stopped' : 'error'
        this.emitEvent(
          exitCode === 0 ? `${name} beendet` : `${name} · Fehler · exit ${exitCode}`,
          exitCode === 0 ? 'muted' : 'error'
        )
        this.changed()
      })

      this.emitEvent(
        `${name} gestartet · ${req.provider}/${req.model}${yolo ? ' [YOLO]' : ''}`,
        yolo ? 'yolo' : 'dispatch'
      )
    } catch (err) {
      info.status = 'error'
      const msg = err instanceof Error ? err.message : String(err)
      managed.buffer = `Spawn fehlgeschlagen: ${msg}\r\n`
      this.emitEvent(`${id} Spawn fehlgeschlagen: ${msg}`, 'error')
    }

    this.changed()
    return info
  }

  /**
   * Dispatch a single headless task. It appears as a read-only pane in the
   * grid, streams parsed provider output, and resolves with the result text
   * (which the orchestrator receives back from dispatch_subagent).
   */
  async runTask(req: RunTaskRequest): Promise<{ info: AgentInstanceInfo; done: Promise<HeadlessResult> }> {
    const id = this.nextId('task')
    const name = this.names.allocate('sub')
    const { workingDir, worktree } = await this.prepareWorkingDir(id, req.workingDir)

    const info: AgentInstanceInfo = {
      id,
      name,
      provider: req.provider,
      model: req.model,
      role: `Task · ${req.role}`,
      kind: 'sub',
      mode: 'task',
      taskId: req.taskId,
      yolo: req.yolo,
      workingDir,
      worktree,
      status: 'running',
      startedAt: Date.now()
    }
    const managed: Managed = { info, buffer: '', seq: 0 }
    this.agents.set(id, managed)

    this.pushData(managed, `\x1b[36m▶ ${name} · ${req.provider}/${req.model} · ${req.role}\x1b[0m\r\n`)
    this.emitEvent(
      `${name} dispatch · ${req.role} · ${req.provider}/${req.model}${req.yolo ? ' [YOLO]' : ''}`,
      req.yolo ? 'yolo' : 'dispatch'
    )

    const handle = runHeadless(
      req.provider,
      req.prompt,
      { model: req.model, workingDir, yolo: req.yolo, systemPrompt: req.systemPrompt },
      (chunk) => this.pushData(managed, chunk),
      { timeoutMs: req.timeoutMs }
    )
    managed.headless = handle
    info.pid = handle.pid
    this.changed()

    const done = handle.done.then((result) => {
      managed.headless = undefined
      if (this.agents.has(id)) {
        const failed =
          result.status === 'failed' ||
          result.status === 'timed_out' ||
          (result.status == null && result.isError)
        info.status = failed ? 'error' : 'stopped'
        info.exitCode = failed ? 1 : 0
        if (
          result.costUsd != null ||
          result.tokensIn != null ||
          result.tokensOut != null ||
          result.steps != null
        ) {
          info.usage = { costUsd: result.costUsd, tokensIn: result.tokensIn, tokensOut: result.tokensOut, steps: result.steps }
        }
        const event =
          result.status === 'cancelled'
            ? { text: `${name} · Task gestoppt`, tone: 'muted' as const }
            : result.status === 'timed_out'
              ? { text: `${name} · Task-Timeout`, tone: 'error' as const }
              : failed
                ? { text: `${name} · Task-Fehler`, tone: 'error' as const }
                : { text: `${name} · ✓ Task fertig`, tone: 'success' as const }
        this.emitEvent(event.text, event.tone)
        this.changed()
      }
      return result
    })

    return { info, done }
  }

  write(id: string, data: string): void {
    this.agents.get(id)?.pty?.write(data)
  }

  resize(id: string, cols: number, rows: number): void {
    if (cols > 0 && rows > 0) this.agents.get(id)?.pty?.resize(cols, rows)
  }

  private terminate(managed: Managed): void {
    if (managed.headless) {
      managed.headless.kill()
      return
    }
    const proc = managed.pty
    if (!proc) return
    if (process.platform === 'win32' && proc.pid) {
      // Kill the whole tree — agent CLIs spawn children (shells, node, git).
      execFile('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { windowsHide: true }, () => {})
    } else {
      proc.kill()
    }
  }

  private isAlive(m: Managed): boolean {
    return Boolean(m.pty || m.headless)
  }

  async kill(id: string): Promise<void> {
    const managed = this.agents.get(id)
    if (!managed) return
    this.terminate(managed)
    managed.info.status = 'stopped'
    this.agents.delete(id)
    this.names.release(managed.info.name)
    this.emitEvent(`${managed.info.name} geschlossen`, 'muted')
    this.changed()
  }

  async killAll(): Promise<void> {
    const running = [...this.agents.values()].filter((m) => this.isAlive(m))
    for (const m of running) {
      this.terminate(m)
      m.info.status = 'stopped'
    }
    this.emitEvent(`⛔ ALLE AGENTS GESTOPPT · ${running.length} beendet`, 'error')
    this.changed()
  }

  /** Stop everything AND remove the panes — a clean slate for the workspace. */
  async removeAll(): Promise<void> {
    const count = this.agents.size
    for (const m of this.agents.values()) {
      this.terminate(m)
      this.names.release(m.info.name)
    }
    this.agents.clear()
    this.emitEvent(`🧹 Workspace geleert · ${count} Agents entfernt`, 'muted')
    this.changed()
  }

  /** True while at least one agent process is alive. */
  anyRunning(): boolean {
    return [...this.agents.values()].some((m) => this.isAlive(m))
  }

  /** Remove exited agents from the list (panes closed in the UI). */
  prune(id: string): void {
    const managed = this.agents.get(id)
    if (managed && !this.isAlive(managed)) {
      this.agents.delete(id)
      this.changed()
    }
  }
}

export const agentManager = new AgentManager()
