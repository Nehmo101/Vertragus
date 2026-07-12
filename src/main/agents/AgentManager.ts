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
import { resolveModel, type ModelPreset } from '@shared/models'
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
import { providerCapacity } from '@main/agents/providerCapacity'
import { seedWithReadyHandshake } from '@main/agents/interactiveReady'

const BUFFER_LIMIT = 200_000 // chars of scrollback kept per agent

interface Managed {
  info: AgentInstanceInfo
  pty?: pty.IPty
  headless?: HeadlessHandle
  buffer: string
  seq: number
  /** True once a usage-limit signal fired for this agent (debounce). */
  limitWarned?: boolean
  /** Provider slot held while running or after acquire for a waiting task. */
  capacityProvider?: AgentProviderId
  /** Set while a headless task waits for provider capacity. */
  waitAbort?: { aborted: boolean }
}

export interface RunTaskRequest {
  provider: AgentProviderId
  model: string
  modelPreset?: ModelPreset
  role: string
  taskId: string
  prompt: string
  systemPrompt?: string
  yolo: boolean
  workingDir?: string
  profileId?: string
  workspaceSessionId?: string
}

export class AgentManager extends EventEmitter {
  private readonly agents = new Map<string, Managed>()
  private readonly names = new NameAllocator()
  private readonly sessionId = randomUUID()
  private seq = 0

  list(profileId?: string): AgentInstanceInfo[] {
    return [...this.agents.values()]
      .filter((managed) => !profileId || managed.info.profileId === profileId)
      .map((managed) => managed.info)
  }

  buffer(id: string): { data: string; seq: number } {
    const m = this.agents.get(id)
    return { data: m?.buffer ?? '', seq: m?.seq ?? 0 }
  }

  private emitEvent(
    text: string,
    tone: OrcaEvent['tone'] = 'info',
    context?: Pick<AgentInstanceInfo, 'profileId' | 'workspaceSessionId'>
  ): void {
    const evt: OrcaEvent = {
      time: Date.now(),
      text,
      tone,
      profileId: context?.profileId,
      workspaceSessionId: context?.workspaceSessionId
    }
    this.emit('event', evt)
  }

  private changed(): void {
    this.emit('changed', this.list())
  }

  private releaseCapacity(managed: Managed): void {
    if (!managed.capacityProvider) return
    providerCapacity.release(managed.capacityProvider)
    managed.capacityProvider = undefined
  }

  private nextId(prefix: string): string {
    this.seq += 1
    return `${prefix}-${String(this.seq).padStart(2, '0')}`
  }

  /** Resolve the effective working dir, creating an isolated worktree if enabled. */
  private async prepareWorkingDir(
    id: string,
    requested: string | undefined,
    isolateOverride?: boolean,
    workspaceSessionId?: string,
    profileId?: string
  ): Promise<{ workingDir: string; worktree?: string; branch?: string }> {
    let workingDir = requested?.trim() || homedir()
    let worktree: string | undefined
    let branch: string | undefined
    const isolate = isolateOverride ?? getSetting<boolean>('worktreeIsolation') ?? true
    if (isolate) {
      const wt = await createWorktree(workingDir, id, workspaceSessionId ?? this.sessionId)
      if (wt) {
        workingDir = wt.path
        worktree = wt.path
        branch = wt.branch
        this.emitEvent(`${id} worktree ${wt.branch} @ ${wt.path}`, 'muted', {
          profileId,
          workspaceSessionId
        })
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
      'warn', managed.info
    )
    this.changed()
  }

  async spawn(req: SpawnAgentRequest): Promise<AgentInstanceInfo> {
    providerCapacity.tryAcquire(req.provider)
    let capacityHeld = true

    const kind = req.kind ?? 'sub'
    const id = this.nextId(kind === 'orchestrator' ? 'orch' : 'sub')
    const name = this.names.allocate(kind)
    const yolo = req.yolo ?? false
    const resolvedModel = resolveModel(req.provider, req)
    const { workingDir, worktree, branch } = await this.prepareWorkingDir(
      id,
      req.workingDir,
      req.isolateWorktree,
      req.workspaceSessionId,
      req.profileId
    )

    // Orchestrators get the Orca MCP server + orchestrator system prompt (which
    // also merges in any orchestrator-scoped external MCP servers). Every other
    // interactive agent gets its subagent-scoped external MCP servers attached
    // so it can see and use them directly.
    const orchestratorSetup =
      kind === 'orchestrator' ? buildOrchestratorSetup(req.provider, name, id, req.workspaceSessionId) : undefined
    if (orchestratorSetup && !orchestratorSetup.capability.supported) {
      providerCapacity.release(req.provider)
      throw new Error(orchestratorSetup.capability.reason ?? `${req.provider} cannot orchestrate.`)
    }
    const extraArgs = orchestratorSetup
      ? orchestratorSetup.extraArgs
      : buildSubagentMcpArgs(req.provider, id)

    const launch = buildInteractiveLaunch(req.provider, {
      model: resolvedModel || undefined,
      workingDir,
      yolo,
      extraArgs
    })
    const resolved = await resolveLaunch(launch.command, launch.args)

    const info: AgentInstanceInfo = {
      id,
      name,
      profileId: req.profileId,
      workspaceSessionId: req.workspaceSessionId,
      provider: req.provider,
      model: resolvedModel,
      role: req.role ?? (kind === 'orchestrator' ? 'Orchestrator · plant & verteilt' : 'Subagent'),
      kind,
      mode: 'interactive',
      yolo,
      workingDir,
      worktree,
      branch,
      status: 'running',
      startedAt: Date.now()
    }
    const managed: Managed = { info, buffer: '', seq: 0, capacityProvider: req.provider }
    capacityHeld = false
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
        this.releaseCapacity(managed)
        info.exitCode = exitCode
        info.status = exitCode === 0 ? 'stopped' : 'error'
        this.emitEvent(
          exitCode === 0 ? `${name} beendet` : `${name} · Fehler · exit ${exitCode}`,
          exitCode === 0 ? 'muted' : 'error', info
        )
        this.changed()
      })

      this.emitEvent(
        `${name} gestartet · ${req.provider}/${resolvedModel || 'CLI-Standard'}${yolo ? ' [YOLO]' : ''}`,
        yolo ? 'yolo' : 'dispatch', info
      )
    } catch (err) {
      if (capacityHeld) providerCapacity.release(req.provider)
      else this.releaseCapacity(managed)
      info.status = 'error'
      const msg = err instanceof Error ? err.message : String(err)
      managed.buffer = `Spawn fehlgeschlagen: ${msg}\r\n`
      this.emitEvent(`${id} Spawn fehlgeschlagen: ${msg}`, 'error', info)
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
      isolateWorktree: false,
      profileId: src.info.profileId,
      workspaceSessionId: src.info.workspaceSessionId
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

    // Seed the new interactive agent once its CLI has booted.
    const seed =
      `Du übernimmst die Arbeit von ${src.info.name}. Lies die Übergabe-Notiz unter "${briefingPath}" ` +
      `und mach genau dort weiter, wo ${src.info.name} aufgehört hat. Bestätige zuerst kurz dein Verständnis der Aufgabe.`
    void this.seedInteractive(target.id, seed)

    this.emitEvent(`↪ Übergabe: ${src.info.name} → ${target.name}`, 'dispatch', src.info)
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

  /**
   * Dispatch a single headless task. It appears as a read-only pane in the
   * grid, streams parsed provider output, and resolves with the result text
   * (which the orchestrator receives back from dispatch_subagent).
   */
  async runTask(req: RunTaskRequest): Promise<{ info: AgentInstanceInfo; done: Promise<HeadlessResult> }> {
    const id = this.nextId('task')
    const name = this.names.allocate('sub')
    const resolvedModel = resolveModel(req.provider, req)
    const { workingDir, worktree, branch } = await this.prepareWorkingDir(
      id,
      req.workingDir,
      undefined,
      req.workspaceSessionId,
      req.profileId
    )

    let resolveDone!: (result: HeadlessResult) => void
    const done = new Promise<HeadlessResult>((resolve) => {
      resolveDone = resolve
    })

    const info: AgentInstanceInfo = {
      id,
      name,
      provider: req.provider,
      profileId: req.profileId,
      workspaceSessionId: req.workspaceSessionId,
      model: resolvedModel,
      role: `Task · ${req.role}`,
      kind: 'sub',
      mode: 'task',
      taskId: req.taskId,
      yolo: req.yolo,
      workingDir,
      worktree,
      branch,
      status: 'waiting',
      startedAt: Date.now()
    }
    const managed: Managed = { info, buffer: '', seq: 0, waitAbort: { aborted: false } }
    this.agents.set(id, managed)

    this.pushData(
      managed,
      `\x1b[33m⏳ ${name} wartet auf ${req.provider}-Kapazität · ${req.role}\x1b[0m\r\n`
    )
    this.changed()

    void this.startRunTask(managed, req, name, resolvedModel, resolveDone)
    return { info, done }
  }

  private async startRunTask(
    managed: Managed,
    req: RunTaskRequest,
    name: string,
    resolvedModel: string,
    resolveDone: (result: HeadlessResult) => void
  ): Promise<void> {
    const id = managed.info.id
    const acquired = await providerCapacity.acquireWait(req.provider, managed.waitAbort)
    if (!acquired || !this.agents.has(id)) {
      resolveDone({ result: '', isError: false, status: 'cancelled' })
      return
    }

    managed.capacityProvider = req.provider
    managed.info.status = 'running'
    this.pushData(managed, `\x1b[36m▶ ${name} · ${req.provider}/${resolvedModel || 'CLI-Standard'} · ${req.role}\x1b[0m\r\n`)
    this.emitEvent(
      `${name} dispatch · ${req.role} · ${req.provider}/${resolvedModel || 'CLI-Standard'}${req.yolo ? ' [YOLO]' : ''}`,
      req.yolo ? 'yolo' : 'dispatch', managed.info
    )

    const handle = runHeadless(
      req.provider,
      req.prompt,
      {
        model: resolvedModel || undefined,
        workingDir: managed.info.workingDir,
        yolo: req.yolo,
        systemPrompt: req.systemPrompt,
        extraArgs: buildSubagentMcpArgs(req.provider, id)
      },
      (chunk) => this.pushData(managed, chunk)
    )
    managed.headless = handle
    managed.info.pid = handle.pid
    this.changed()

    try {
      const result = await handle.done
      resolveDone(result)
      if (this.agents.has(id)) {
        const failed =
          result.status === 'failed' ||
          (result.status == null && result.isError)
        managed.info.status = failed ? 'error' : 'stopped'
        managed.info.exitCode = failed ? 1 : 0
        if (
          result.costUsd != null ||
          result.tokensIn != null ||
          result.tokensOut != null ||
          result.steps != null
        ) {
          managed.info.usage = {
            costUsd: result.costUsd,
            tokensIn: result.tokensIn,
            tokensOut: result.tokensOut,
            steps: result.steps
          }
        }
        const event =
          result.status === 'cancelled'
            ? { text: `${name} · Task gestoppt`, tone: 'muted' as const }
            : failed
              ? { text: `${name} · Task-Fehler`, tone: 'error' as const }
                : { text: `${name} · ✓ Task fertig`, tone: 'success' as const }
        this.emitEvent(event.text, event.tone, managed.info)
        this.changed()
      }
    } finally {
      managed.headless = undefined
      this.releaseCapacity(managed)
    }
  }

  write(id: string, data: string): void {
    this.agents.get(id)?.pty?.write(data)
  }

  /**
   * Feed a prompt to an interactive agent after its CLI finishes booting.
   * Uses output-idle detection plus bounded seed retries instead of a fixed delay.
   */
  async seedInteractive(id: string, prompt: string): Promise<void> {
    await seedWithReadyHandshake(
      (text) => this.write(id, text),
      () => {
        const managed = this.agents.get(id)
        return {
          buffer: managed?.buffer ?? '',
          alive: managed ? this.isAlive(managed) : false
        }
      },
      prompt
    )
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
    return Boolean(m.pty || m.headless || m.info.status === 'waiting')
  }

  async kill(id: string): Promise<void> {
    const managed = this.agents.get(id)
    if (!managed) return

    if (managed.info.status === 'waiting' && !managed.headless) {
      if (managed.waitAbort) managed.waitAbort.aborted = true
      this.releaseCapacity(managed)
      this.agents.delete(id)
      this.names.release(managed.info.name)
      this.emitEvent(`${managed.info.name} · Warteschlange abgebrochen`, 'muted')
      this.changed()
      return
    }

    this.terminate(managed)
    this.releaseCapacity(managed)
    managed.info.status = 'stopped'
    this.agents.delete(id)
    this.names.release(managed.info.name)
    this.emitEvent(`${managed.info.name} geschlossen`, 'muted', managed.info)
    this.changed()
  }

  async killAll(profileId?: string): Promise<void> {
    const running = [...this.agents.values()].filter(
      (m) => (this.isAlive(m) || m.info.status === 'waiting') && (!profileId || m.info.profileId === profileId)
    )
    for (const m of running) {
      if (m.info.status === 'waiting' && !m.headless) {
        if (m.waitAbort) m.waitAbort.aborted = true
        this.releaseCapacity(m)
        m.info.status = 'stopped'
        continue
      }
      this.terminate(m)
      this.releaseCapacity(m)
      m.info.status = 'stopped'
    }
    this.emitEvent(`⛔ ALLE AGENTS GESTOPPT · ${running.length} beendet`, 'error', { profileId })
    this.changed()
  }

  /** Stop everything AND remove the panes — a clean slate for the workspace. */
  async removeAll(profileId?: string): Promise<void> {
    const targets = [...this.agents.entries()].filter(
      ([, managed]) => !profileId || managed.info.profileId === profileId
    )
    const count = targets.length
    for (const [id, managed] of targets) {
      if (managed.waitAbort) managed.waitAbort.aborted = true
      this.terminate(managed)
      this.releaseCapacity(managed)
      this.names.release(managed.info.name)
      this.agents.delete(id)
    }
    this.emitEvent(`🧹 Workspace geleert · ${count} Agents entfernt`, 'muted', { profileId })
    this.changed()
  }

  /** True while at least one agent process is alive. */
  anyRunning(profileId?: string): boolean {
    return [...this.agents.values()].some(
      (managed) => this.isAlive(managed) && (!profileId || managed.info.profileId === profileId)
    )
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
