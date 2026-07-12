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
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import * as pty from '@lydell/node-pty'
import type {
  AgentInstanceInfo,
  HandoffRequest,
  OrcaEvent,
  SpawnAgentRequest
} from '@shared/agents'
import { getProvider, type AgentProviderId, type ProviderId } from '@shared/providers'
import { buildInteractiveLaunch } from '@main/providers/types'
import { resolveLaunch } from '@main/agents/resolveCommand'
import { createWorktree } from '@main/agents/worktree'
import { getSetting } from '@main/config/store'
import { runHeadless, type HeadlessHandle, type HeadlessResult } from '@main/agents/headless'
import { buildOrchestratorSetup } from '@main/orchestrator/orchestratorLaunch'
import { buildSubagentMcpArgs } from '@main/orchestrator/externalMcp'
import { NameAllocator } from '@main/agents/names'
import { detectLimit, limitKindLabel } from '@main/agents/limitSignals'
import { buildBriefing } from '@main/agents/handoff'
import { agentIdentityInstruction, isReusableTeamMember } from '@main/agents/teamReuse'
import { closePaneWindows } from '@main/windows'

const BUFFER_LIMIT = 200_000 // chars of scrollback kept per agent

interface Managed {
  info: AgentInstanceInfo
  pty?: pty.IPty
  headless?: HeadlessHandle
  buffer: string
  seq: number
  /** True once a usage-limit signal fired for this agent (debounce). */
  limitWarned?: boolean
  /** Protect a team pane from automatic reuse after the user typed into it. */
  interactiveUsed?: boolean
  /** Ignore the interactive PTY exit while converting this pane into a task. */
  reassigning?: boolean
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
    requested: string | undefined,
    isolateOverride?: boolean
  ): Promise<{ workingDir: string; worktree?: string; branch?: string }> {
    let workingDir = requested?.trim() || homedir()
    let worktree: string | undefined
    let branch: string | undefined
    const isolate = isolateOverride ?? getSetting<boolean>('worktreeIsolation') ?? true
    if (isolate) {
      const wt = await createWorktree(workingDir, id, this.sessionId)
      if (wt) {
        workingDir = wt.path
        worktree = wt.path
        branch = wt.branch
        this.emitEvent(`${id} worktree ${wt.branch} @ ${wt.path}`, 'muted')
      }
    }
    return { workingDir, worktree, branch }
  }

  private pushData(managed: Managed, data: string): void {
    managed.buffer = (managed.buffer + data).slice(-BUFFER_LIMIT)
    managed.seq += 1
    this.emit('data', { id: managed.info.id, data, seq: managed.seq })
    this.scanForLimit(managed)
  }

  /**
   * Best-effort scan of an interactive agent's output for a usage-limit banner.
   * Fires once per agent (debounced). Marks `info.limitWarning` and emits a warn
   * event so the UI can surface a handoff. Detection is heuristic (text-based).
   */
  private scanForLimit(managed: Managed): void {
    if (managed.limitWarned || managed.info.mode !== 'interactive') return
    // Login terminals for integrations are represented like interactive agents,
    // but only executable agent providers can emit model usage-limit signals.
    if (managed.info.provider === 'github' || managed.info.provider === 'cloudflare') return
    // Match against a short tail so phrases split across chunks are still caught.
    const hit = detectLimit(managed.info.provider, managed.buffer.slice(-2000))
    if (!hit) return
    managed.limitWarned = true
    managed.info.limitWarning = { kind: hit.kind, detectedAt: Date.now(), note: hit.note }
    this.emitEvent(
      `⚠ ${managed.info.name} nähert sich einem Limit (${limitKindLabel(hit.kind)}) — Übergabe möglich`,
      'warn'
    )
    this.changed()
  }

  async spawn(req: SpawnAgentRequest): Promise<AgentInstanceInfo> {
    const kind = req.kind ?? 'sub'
    const id = this.nextId(kind === 'orchestrator' ? 'orch' : 'sub')
    const name = this.names.allocate(kind)
    const yolo = req.yolo ?? false
    const { workingDir, worktree, branch } = await this.prepareWorkingDir(
      id,
      req.workingDir,
      req.isolateWorktree
    )

    // Orchestrators get the Orca MCP server + orchestrator system prompt (which
    // also merges in any orchestrator-scoped external MCP servers). Every other
    // interactive agent gets its subagent-scoped external MCP servers attached
    // so it can see and use them directly.
    const orchestratorSetup =
      kind === 'orchestrator' ? buildOrchestratorSetup(req.provider, name, id) : undefined
    if (orchestratorSetup && !orchestratorSetup.capability.supported) {
      throw new Error(orchestratorSetup.capability.reason ?? `${req.provider} cannot orchestrate.`)
    }
    const extraArgs = orchestratorSetup
      ? orchestratorSetup.extraArgs
      : buildSubagentMcpArgs(req.provider, id)

    const launch = buildInteractiveLaunch(req.provider, {
      model: req.model,
      workingDir,
      yolo,
      extraArgs
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
      teamRole: req.teamRole,
      workingDir,
      worktree,
      branch,
      status: 'running',
      startedAt: Date.now()
    }
    const managed: Managed = { info, buffer: '', seq: 0 }
    this.agents.set(id, managed)
    if (req.teamRole) {
      this.pushData(
        managed,
        `\x1b[36m▶ Orca-Identität: ${name} · Team ${req.teamRole} · ${req.provider}/${req.model || 'Standard'}\x1b[0m\r\n`
      )
    }

    try {
      const proc = pty.spawn(resolved.file, resolved.args, {
        name: 'xterm-256color',
        cols: 100,
        rows: 30,
        cwd: workingDir,
        env: {
          ...process.env,
          ORCA_AGENT_NAME: name,
          ORCA_AGENT_ROLE: req.teamRole ?? info.role
        } as Record<string, string>
      })
      managed.pty = proc
      info.pid = proc.pid

      proc.onData((data) => this.pushData(managed, data))
      proc.onExit(({ exitCode }) => {
        const wasReassigned = managed.reassigning
        managed.pty = undefined
        if (wasReassigned) {
          managed.reassigning = false
          return
        }
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

  /** Persist a handoff briefing to an absolute path and return it. */
  private writeBriefing(sourceId: string, targetId: string, at: number, content: string): string {
    const dir = join(app.getPath('userData'), 'orca-handoffs')
    mkdirSync(dir, { recursive: true })
    const file = join(dir, `handoff-${sourceId}-to-${targetId}-${at}.md`)
    writeFileSync(file, content, 'utf8')
    return file
  }

  /**
   * Hand a source agent's live work over to a freshly spawned agent.
   *
   * The new agent starts in the SOURCE's working tree (so it sees the source's
   * uncommitted work, and no nested worktree is created), gets a handoff
   * briefing written to an absolute path, and is seeded with a short prompt
   * telling it to read that briefing and continue. The source keeps running and
   * is marked as handed off.
   */
  async handoff(req: HandoffRequest): Promise<AgentInstanceInfo> {
    const src = this.agents.get(req.sourceId)
    if (!src) throw new Error(`Quell-Agent ${req.sourceId} nicht gefunden.`)

    const target = await this.spawn({
      provider: req.provider,
      model: req.model,
      role: req.role?.trim() || `Übernahme von ${src.info.name}`,
      yolo: req.yolo ?? src.info.yolo,
      workingDir: src.info.workingDir,
      isolateWorktree: false
    })
    // If spawn failed to register (e.g. PTY error), surface the info as-is.
    if (!this.agents.has(target.id)) return target

    const at = Date.now()
    const briefing = buildBriefing({
      source: src.info,
      targetName: target.name,
      task: req.task,
      summary: req.summary,
      scrollback: src.buffer,
      scrollbackChars: getSetting<number>('handoff.scrollbackChars'),
      timestamp: at
    })
    const briefingPath = this.writeBriefing(req.sourceId, target.id, at, briefing)

    // Mark both ends; the source keeps running (user choice).
    src.info.handoffTo = { id: target.id, name: target.name, at }
    target.handoffFrom = { id: src.info.id, name: src.info.name, at }

    // Seed the new interactive agent once its CLI has booted (same delay/pattern
    // as Engine.openSubwindow). The prompt only points at the briefing file, so
    // large scrollbacks never have to be typed into the PTY.
    const seed =
      `Du übernimmst die Arbeit von ${src.info.name}. Lies die Übergabe-Notiz unter "${briefingPath}" ` +
      `und mach genau dort weiter, wo ${src.info.name} aufgehört hat. Bestätige zuerst kurz dein Verständnis der Aufgabe.`
    setTimeout(() => this.write(target.id, seed + '\r'), 1500)

    this.emitEvent(`↪ Übergabe: ${src.info.name} → ${target.name}`, 'dispatch')
    this.changed()
    return target
  }

  /** Open the provider-owned interactive login flow in a normal Orca terminal. */
  async loginProvider(provider: ProviderId): Promise<AgentInstanceInfo> {
    const def = getProvider(provider)
    if (!def?.auth) throw new Error(`Für ${provider} ist kein Login-Flow registriert.`)

    const taskId = `auth:${provider}`
    const running = [...this.agents.values()].find(
      (managed) => managed.info.taskId === taskId && this.isAlive(managed)
    )
    if (running) return running.info

    const id = this.nextId('auth')
    const name = `${def.label} Login`
    const workingDir = homedir()
    const resolved = await resolveLaunch(def.command, def.auth.loginArgs)
    const info: AgentInstanceInfo = {
      id,
      name,
      provider,
      model: 'Konto-Verbindung',
      role: `Provider-Login · ${def.label}`,
      kind: 'sub',
      mode: 'interactive',
      taskId,
      yolo: false,
      workingDir,
      status: 'running',
      startedAt: Date.now()
    }
    const managed: Managed = { info, buffer: '', seq: 0 }
    this.agents.set(id, managed)
    this.pushData(
      managed,
      `\x1b[36m▶ Sicherer ${def.label}-Login über die offizielle CLI\x1b[0m\r\n` +
        '\x1b[90mOrca speichert keine Tokens oder Passwörter. Folge den Hinweisen der CLI.\x1b[0m\r\n\r\n'
    )

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
        if (!this.agents.has(id)) return
        info.exitCode = exitCode
        info.status = exitCode === 0 ? 'stopped' : 'error'
        this.emitEvent(
          exitCode === 0
            ? `${def.label}-Login abgeschlossen`
            : `${def.label}-Login fehlgeschlagen · exit ${exitCode}`,
          exitCode === 0 ? 'success' : 'error'
        )
        this.emit('provider-auth-complete', provider)
        this.changed()
      })
      this.emitEvent(`${def.label}-Login geöffnet`, 'info')
    } catch (error) {
      info.status = 'error'
      const message = error instanceof Error ? error.message : String(error)
      this.pushData(managed, `\x1b[31mLogin konnte nicht gestartet werden: ${message}\x1b[0m\r\n`)
      this.emit('provider-auth-complete', provider)
    }
    this.changed()
    return info
  }

  /** Claim an untouched profile-team pane before allocating another subagent. */
  private claimTeamMember(req: RunTaskRequest): Managed | undefined {
    return [...this.agents.values()].find((managed) =>
      isReusableTeamMember(
        managed.info,
        { provider: req.provider, model: req.model, role: req.role },
        { hasPty: Boolean(managed.pty), interactiveUsed: Boolean(managed.interactiveUsed) }
      )
    )
  }

  /**
   * Dispatch a single headless task. A matching untouched team pane is reused
   * first; only overflow work allocates another named subagent pane.
   */
  async runTask(req: RunTaskRequest): Promise<{ info: AgentInstanceInfo; done: Promise<HeadlessResult> }> {
    let managed = this.claimTeamMember(req)

    if (managed) {
      const proc = managed.pty!
      managed.reassigning = true
      managed.pty = undefined
      this.terminatePty(proc)

      const info = managed.info
      info.role = `Task · ${req.role}`
      info.mode = 'task'
      info.taskId = req.taskId
      info.yolo = req.yolo
      info.status = 'running'
      info.startedAt = Date.now()
      info.pid = undefined
      info.exitCode = undefined
      info.usage = undefined
      info.limitWarning = undefined
      managed.limitWarned = false
      this.pushData(
        managed,
        `\r\n\x1b[36m▶ ${info.name} übernimmt als ${req.role} die Orchestrator-Aufgabe.\x1b[0m\r\n`
      )
      this.emitEvent(`${info.name} übernimmt vorbereiteten Team-Slot · ${req.role}`, 'dispatch')
    } else {
      const id = this.nextId('task')
      const name = this.names.allocate('sub')
      const { workingDir, worktree, branch } = await this.prepareWorkingDir(id, req.workingDir)
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
        branch,
        status: 'running',
        startedAt: Date.now()
      }
      managed = { info, buffer: '', seq: 0 }
      this.agents.set(id, managed)
      this.pushData(
        managed,
        `\x1b[36m▶ ${name} · zusätzlicher Worker · ${req.provider}/${req.model || 'Standard'} · ${req.role}\x1b[0m\r\n`
      )
      this.emitEvent(
        `${name} zusätzlich gestartet · ${req.role} · ${req.provider}/${req.model}${req.yolo ? ' [YOLO]' : ''}`,
        req.yolo ? 'yolo' : 'dispatch'
      )
    }

    if (!managed) throw new Error('Task-Agent konnte nicht vorbereitet werden.')
    const active = managed
    const info = active.info
    const { id, name, workingDir } = info
    const identityInstruction = agentIdentityInstruction(name)
    const taskPrompt = `${identityInstruction}\n\n${req.prompt}`
    const systemPrompt = req.systemPrompt
      ? `${identityInstruction} ${req.systemPrompt}`
      : identityInstruction

    const handle = runHeadless(
      req.provider,
      taskPrompt,
      {
        model: req.model,
        workingDir,
        yolo: req.yolo,
        systemPrompt,
        // Attach the subagent-scoped external MCP servers to this headless run.
        extraArgs: buildSubagentMcpArgs(req.provider, id)
      },
      (chunk) => this.pushData(active, chunk)
    )
    active.headless = handle
    info.pid = handle.pid
    this.changed()

    const done = handle.done.then((result) => {
      active.headless = undefined
      if (this.agents.has(id)) {
        const failed =
          result.status === 'failed' ||
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
            ? { text: `${name} · Task gestoppt · Fenster geschlossen`, tone: 'muted' as const }
            : failed
              ? { text: `${name} · Task-Fehler · Fenster geschlossen`, tone: 'error' as const }
              : { text: `${name} · ✓ Task fertig · Fenster geschlossen`, tone: 'success' as const }
        this.emitEvent(event.text, event.tone)
        this.agents.delete(id)
        this.names.release(name)
        closePaneWindows(id)
        this.changed()
      }
      return result
    })

    return { info, done }
  }

  write(id: string, data: string): void {
    const managed = this.agents.get(id)
    if (!managed?.pty) return
    if (managed.info.teamRole && data.length > 0) managed.interactiveUsed = true
    managed.pty.write(data)
  }

  resize(id: string, cols: number, rows: number): void {
    if (cols > 0 && rows > 0) this.agents.get(id)?.pty?.resize(cols, rows)
  }

  private terminatePty(proc: pty.IPty): void {
    if (process.platform === 'win32' && proc.pid) {
      // Kill the whole tree — agent CLIs spawn children (shells, node, git).
      execFile('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { windowsHide: true }, () => {})
    } else {
      proc.kill()
    }
  }

  private terminate(managed: Managed): void {
    if (managed.headless) {
      managed.headless.kill()
      return
    }
    if (managed.pty) this.terminatePty(managed.pty)
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
