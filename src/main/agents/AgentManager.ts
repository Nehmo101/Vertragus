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
import type { PanePreflightReport } from '@shared/orchestrator'
import {
  getProvider,
  isModelDisabled,
  normalizeDisabledModels,
  normalizeProviderEnabled,
  type AgentProviderId,
  type ProviderId
} from '@shared/providers'
import { resolveModel, type ModelPreset } from '@shared/models'
import { buildInteractiveLaunch } from '@main/providers/types'
import { resolveLaunch } from '@main/agents/resolveCommand'
import { createWorktree, rollbackWorktree } from '@main/agents/worktree'
import { canonicalWorkspacePath, workspacePathKey } from '@main/agents/workspacePath'
import {
  PanePreflightError,
  runPanePreflight,
  type PanePreflightInput
} from '@main/agents/panePreflight'
import { cursorWorkspaceTrustPrompt } from '@main/agents/cursorWorkspaceTrust'
import { getProfile, getSetting } from '@main/config/store'
import {
  runHeadless,
  type HeadlessHandle,
  type HeadlessLifecycleOptions,
  type HeadlessResult
} from '@main/agents/headless'
import { buildOrchestratorSetup } from '@main/orchestrator/orchestratorLaunch'
import { buildSubagentMcpArgs } from '@main/orchestrator/externalMcp'
import { NameAllocator } from '@main/agents/names'
import { detectLimit, limitKindLabel, stripAnsi } from '@main/agents/limitSignals'
import { buildBriefing } from '@main/agents/handoff'
import { providerCapacity } from '@main/agents/providerCapacity'
import { seedWithReadyHandshake } from '@main/agents/interactiveReady'
import { agentIdentityInstruction, isReusableTeamMember } from '@main/agents/teamReuse'
import { closePaneWindows } from '@main/windows'

const BUFFER_LIMIT = 200_000 // chars of scrollback kept per agent
const CURSOR_TRUST_RETRY_DELAY_MS = 150
const CURSOR_TRUST_MAX_RETRIES = 3
const CURSOR_TRUST_WATCHDOG_MS = 8_000

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
  /** Protect a team pane from automatic reuse after the user typed into it. */
  interactiveUsed?: boolean
  /** Cursor's startup trust confirmation was handled for an Orca worktree. */
  workspaceTrustHandled?: boolean
  /** A bounded retry while Cursor renders its trust screen across PTY chunks. */
  workspaceTrustRetry?: ReturnType<typeof setTimeout>
  workspaceTrustRetryCount?: number
  /** Detect and recover when Cursor stays on "Trusting workspace..." indefinitely. */
  workspaceTrustWatchdog?: ReturnType<typeof setTimeout>
  workspaceTrustNudged?: boolean
  /** Ignore the interactive PTY exit while converting this pane into a task. */
  reassigning?: boolean
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
  engineId?: string
}

export type PanePreflightRunner = (input: PanePreflightInput) => Promise<PanePreflightReport>

function assertModelSelection(provider: AgentProviderId, model: string): void {
  if (provider === 'ollama' && !model) {
    throw new Error(
      'Ollama benötigt ein lokal installiertes Modell. Bitte ein Modell aus der Live-Liste auswählen.'
    )
  }
}

function assertProviderSelection(provider: AgentProviderId, model: string): void {
  const enabled = normalizeProviderEnabled(getSetting('providerEnabled'))
  if (!enabled[provider]) {
    throw new Error(`Provider ${provider} ist global deaktiviert.`)
  }
  const disabledModels = normalizeDisabledModels(getSetting('disabledModels'))
  if (isModelDisabled(disabledModels, provider, model)) {
    throw new Error(`Modell ${provider}/${model} ist global deaktiviert.`)
  }
}

export class AgentManager extends EventEmitter {
  private readonly agents = new Map<string, Managed>()
  private readonly preflightReports = new Map<string, PanePreflightReport>()

  constructor(private readonly preflightRunner: PanePreflightRunner = runPanePreflight) {
    super()
  }
  private readonly names = new NameAllocator()
  private readonly sessionId = randomUUID()
  private seq = 0

  list(profileId?: string): AgentInstanceInfo[] {
    return [...this.agents.values()]
      .filter((managed) => !profileId || managed.info.profileId === profileId)
      .map((managed) => managed.info)
  }

  private preflightKey(provider: AgentProviderId, workingDir: string): string {
    return `${provider}:${workspacePathKey(workingDir)}`
  }

  latestPreflight(provider: AgentProviderId, workingDir: string): PanePreflightReport | undefined {
    return this.preflightReports.get(this.preflightKey(provider, workingDir))
  }

  async preflightSlot(input: PanePreflightInput): Promise<PanePreflightReport> {
    try {
      const report = await this.preflightRunner(input)
      this.preflightReports.set(this.preflightKey(input.provider, input.workingDir), report)
      return report
    } catch (error) {
      if (error instanceof PanePreflightError) {
        this.preflightReports.set(this.preflightKey(input.provider, input.workingDir), error.report)
      }
      throw error
    }
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
    let workingDir = await canonicalWorkspacePath(requested?.trim() || homedir())
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
    this.autoTrustCursorWorktree(managed)
    this.monitorCursorWorkspaceTrust(managed)
  }


  /**
   * Cursor's --trust flag is headless-only. In interactive mode, confirm its
   * initial prompt only when this manager created the isolated worktree.
   */
  private clearCursorWorkspaceTrustRetry(managed: Managed): void {
    if (managed.workspaceTrustRetry) {
      clearTimeout(managed.workspaceTrustRetry)
      managed.workspaceTrustRetry = undefined
    }
    if (managed.workspaceTrustWatchdog) {
      clearTimeout(managed.workspaceTrustWatchdog)
      managed.workspaceTrustWatchdog = undefined
    }
  }

  private cursorTrustProgressVisible(managed: Managed): boolean {
    const tail = stripAnsi(managed.buffer.slice(-800)).replace(/\r/g, '\n').trimEnd()
    return /Trusting workspace(?:\.{3})?\s*$/i.test(tail)
  }

  private monitorCursorWorkspaceTrust(managed: Managed): void {
    if (!managed.workspaceTrustHandled || !managed.pty || managed.info.provider !== 'cursor') return
    if (!this.cursorTrustProgressVisible(managed)) {
      if (managed.workspaceTrustWatchdog) this.clearCursorWorkspaceTrustRetry(managed)
      return
    }
    if (managed.workspaceTrustWatchdog) return
    managed.workspaceTrustWatchdog = setTimeout(() => {
      managed.workspaceTrustWatchdog = undefined
      if (!this.agents.has(managed.info.id) || !managed.pty || !this.cursorTrustProgressVisible(managed)) return
      if (!managed.workspaceTrustNudged) {
        managed.workspaceTrustNudged = true
        managed.pty.write('\r')
        this.emitEvent(`${managed.info.name} - Cursor-Trust reagiert nicht; Enter wird erneut gesendet.`, 'warn', managed.info)
        this.monitorCursorWorkspaceTrust(managed)
        return
      }
      managed.reassigning = true
      this.terminate(managed)
      this.releaseCapacity(managed)
      managed.info.status = 'error'
      this.pushData(
        managed,
        '\r\n\x1b[31mCursor blieb bei der Workspace-Trust-Bestaetigung haengen. Der Agent wurde beendet und kann vom Orchestrator ersetzt werden.\x1b[0m\r\n'
      )
      this.emitEvent(`${managed.info.name} - Cursor Workspace-Trust fehlgeschlagen`, 'error', managed.info)
      this.changed()
    }, CURSOR_TRUST_WATCHDOG_MS)
  }

  private retryCursorWorkspaceTrust(managed: Managed): void {
    if (
      managed.workspaceTrustRetry ||
      managed.workspaceTrustHandled ||
      (managed.workspaceTrustRetryCount ?? 0) >= CURSOR_TRUST_MAX_RETRIES
    ) {
      return
    }
    managed.workspaceTrustRetryCount = (managed.workspaceTrustRetryCount ?? 0) + 1
    managed.workspaceTrustRetry = setTimeout(() => {
      managed.workspaceTrustRetry = undefined
      if (!this.agents.has(managed.info.id) || !managed.pty) return
      this.autoTrustCursorWorktree(managed)
    }, CURSOR_TRUST_RETRY_DELAY_MS)
  }

  private autoTrustCursorWorktree(managed: Managed): void {
    const { info } = managed
    if (info.provider !== 'cursor' || !managed.pty) return
    const prompt = cursorWorkspaceTrustPrompt({
      output: managed.buffer,
      workingDir: info.workingDir,
      worktree: info.worktree,
      alreadyHandled: Boolean(managed.workspaceTrustHandled),
      interactiveUsed: Boolean(managed.interactiveUsed)
    })
    if (prompt === 'none') return
    if (prompt === 'partial') {
      this.retryCursorWorkspaceTrust(managed)
      return
    }

    this.clearCursorWorkspaceTrustRetry(managed)
    managed.workspaceTrustHandled = true
    managed.pty.write('a\r')
    this.emitEvent(`${info.name} · Cursor-Trust für Orca-Worktree bestätigt (a gesendet)`, 'dispatch', info)
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
    const resolvedModel = resolveModel(req.provider, req)
    assertProviderSelection(req.provider, resolvedModel)
    assertModelSelection(req.provider, resolvedModel)
    providerCapacity.tryAcquire(req.provider)
    let capacityHeld = true

    const kind = req.kind ?? 'sub'
    const id = this.nextId(kind === 'orchestrator' ? 'orch' : 'sub')
    const name = this.names.allocate(kind)
    const yolo = req.yolo ?? false
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
    const orchestratorProfile = kind === 'orchestrator' && req.profileId
      ? getProfile(req.profileId)
      : undefined
    const orchestratorSetup = kind === 'orchestrator'
      ? buildOrchestratorSetup(req.provider, name, id, req.workspaceSessionId, {
          adaptiveTeam: orchestratorProfile?.planner.routingMode === 'adaptive',
          maxRetries: orchestratorProfile?.planner.maxRetries,
          engineId: req.engineId
        })
      : undefined
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
      engineId: req.engineId,
      provider: req.provider,
      model: resolvedModel,
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
    const managed: Managed = { info, buffer: '', seq: 0, capacityProvider: req.provider }
    capacityHeld = false
    this.agents.set(id, managed)
    if (req.teamRole) {
      this.pushData(
        managed,
        `\x1b[36m▶ Orca-Identität: ${name} · Team ${req.teamRole} · ${req.provider}/${resolvedModel || 'CLI-Standard'}\x1b[0m\r\n`
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
        this.clearCursorWorkspaceTrustRetry(managed)
        if (wasReassigned) {
          managed.reassigning = false
          return
        }
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
        if (exitCode === 0) {
          this.agents.delete(id)
          closePaneWindows(id)
        }
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
        {
          provider: req.provider,
          model: req.model,
          role: req.role,
          profileId: req.profileId,
          workspaceSessionId: req.workspaceSessionId
        },
        { hasPty: Boolean(managed.pty), interactiveUsed: Boolean(managed.interactiveUsed) }
      )
    )
  }

  /**
   * Dispatch a single headless task. A matching untouched team pane is reused
   * first; only overflow work allocates another named subagent pane.
   */
  async runTask(
    req: RunTaskRequest,
    lifecycle?: HeadlessLifecycleOptions
  ): Promise<{ info: AgentInstanceInfo; done: Promise<HeadlessResult>; baseCommit?: string }> {
    const resolvedModel = resolveModel(req.provider, req)
    assertProviderSelection(req.provider, resolvedModel)
    assertModelSelection(req.provider, resolvedModel)
    const taskReq = { ...req, model: resolvedModel }
    let managed = this.claimTeamMember(taskReq)

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
      info.model = resolvedModel
      info.profileId = req.profileId ?? info.profileId
      info.workspaceSessionId = req.workspaceSessionId ?? info.workspaceSessionId
      info.engineId = req.engineId ?? info.engineId
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
      this.emitEvent(`${info.name} übernimmt vorbereiteten Team-Slot · ${req.role}`, 'dispatch', info)
    } else {
      const id = this.nextId('task')
      const name = this.names.allocate('sub')
      const { workingDir, worktree, branch } = await this.prepareWorkingDir(
        id,
        req.workingDir,
        undefined,
        req.workspaceSessionId,
        req.profileId
      )
      const info: AgentInstanceInfo = {
        id,
        name,
        provider: req.provider,
        profileId: req.profileId,
        workspaceSessionId: req.workspaceSessionId,
        engineId: req.engineId,
        model: resolvedModel,
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
        `\x1b[36m▶ ${name} · zusätzlicher Worker · ${req.provider}/${resolvedModel || 'Standard'} · ${req.role}\x1b[0m\r\n`
      )
      this.emitEvent(
        `${name} zusätzlich gestartet · ${req.role} · ${req.provider}/${resolvedModel || 'Standard'}${req.yolo ? ' [YOLO]' : ''}`,
        req.yolo ? 'yolo' : 'dispatch',
        info
      )
    }

    if (!managed) throw new Error('Task-Agent konnte nicht vorbereitet werden.')
    const active = managed
    const info = active.info
    const { id, name, workingDir } = info
    try {
      info.preflight = await this.preflightSlot({
        provider: req.provider,
        workingDir,
        worktree: info.worktree,
        engineId: req.engineId,
        workspaceSessionId: req.workspaceSessionId
      })
    } catch (error) {
      info.preflight = error instanceof PanePreflightError ? error.report : undefined
      info.status = 'error'
      info.exitCode = 1
      const message = error instanceof Error ? error.message : String(error)
      this.pushData(active, `\r\n\x1b[31mPane-Preflight fehlgeschlagen: ${message}\x1b[0m\r\n`)
      this.emitEvent(`${name} · Pane-Preflight fehlgeschlagen`, 'error', info)
      this.changed()
      throw error
    }
    const identityInstruction = agentIdentityInstruction(name)
    const taskPrompt = `${identityInstruction}\n\n${req.prompt}`
    const systemPrompt = req.systemPrompt
      ? `${identityInstruction} ${req.systemPrompt}`
      : identityInstruction

    const baseCommit = info.worktree
      ? await new Promise<string | undefined>((resolve) => {
          execFile(
            'git', ['rev-parse', '--verify', 'HEAD^{commit}'],
            { cwd: info.worktree, windowsHide: true },
            (error, stdout) => resolve(error ? undefined : stdout.trim().toLowerCase())
          )
        })
      : undefined

    const handle = runHeadless(
      req.provider,
      taskPrompt,
      {
        model: resolvedModel || undefined,
        workingDir,
        yolo: req.yolo,
        systemPrompt,
        extraArgs: buildSubagentMcpArgs(req.provider, id)
      },
      (chunk) => this.pushData(active, chunk),
      lifecycle
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
          info.usage = {
            costUsd: result.costUsd,
            tokensIn: result.tokensIn,
            tokensOut: result.tokensOut,
            steps: result.steps
          }
        }
        const event =
          result.status === 'cancelled'
            ? { text: `${name} · Task gestoppt · Chat ausgeblendet`, tone: 'muted' as const }
            : failed
              ? { text: `${name} · Task-Fehler · Chat ausgeblendet`, tone: 'error' as const }
              : { text: `${name} · ✓ Task fertig · Chat ausgeblendet`, tone: 'success' as const }
        this.emitEvent(event.text, event.tone, info)
        // Keep the finished task and its scrollback until the workspace is
        // explicitly cleared or rebuilt. The renderer hides it by default.
        closePaneWindows(id)
        this.changed()
      }
      return result
    })

    return { info, done, baseCommit }
  }

  write(id: string, data: string): void {
    const managed = this.agents.get(id)
    if (!managed?.pty) return
    managed.pty.write(data)
  }

  /** Mark only explicit renderer keyboard/paste activity, not xterm protocol replies. */
  markInteractiveUsed(id: string): void {
    const managed = this.agents.get(id)
    if (!managed || managed.info.mode !== 'interactive') return
    managed.interactiveUsed = true
    this.clearCursorWorkspaceTrustRetry(managed)
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
    this.clearCursorWorkspaceTrustRetry(managed)
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
      this.clearCursorWorkspaceTrustRetry(m)
      this.releaseCapacity(m)
      m.info.status = 'stopped'
    }
    this.emitEvent(`⛔ ALLE AGENTS GESTOPPT · ${running.length} beendet`, 'error', { profileId })
    this.changed()
  }

  /** Stop everything AND remove the panes — a clean slate for the workspace. */
  async removeAll(profileId?: string, workspaceSessionId?: string): Promise<void> {
    const targets = [...this.agents.entries()].filter(
      ([, managed]) =>
        (!profileId || managed.info.profileId === profileId) &&
        (!workspaceSessionId || managed.info.workspaceSessionId === workspaceSessionId)
    )
    const count = targets.length
    const rollbacks: Array<{ name: string; worktree: string; branch?: string }> = []
    for (const [id, managed] of targets) {
      if (managed.waitAbort) managed.waitAbort.aborted = true
      this.terminate(managed)
      this.clearCursorWorkspaceTrustRetry(managed)
      this.releaseCapacity(managed)
      this.names.release(managed.info.name)
      if (managed.info.worktree) {
        rollbacks.push({
          name: managed.info.name,
          worktree: managed.info.worktree,
          branch: managed.info.branch
        })
      }
      this.agents.delete(id)
    }
    this.emitEvent(`🧹 Workspace geleert · ${count} Agents entfernt`, 'muted', { profileId })
    this.changed()
    // Roll the killed agents back: discard each isolated worktree + branch so a
    // removed workspace run leaves no orphaned checkout behind. Best-effort.
    await this.rollbackWorktrees(rollbacks, { profileId, workspaceSessionId })
  }

  /** Discard each agent's isolated worktree; failures never block the removal. */
  private async rollbackWorktrees(
    entries: Array<{ name: string; worktree: string; branch?: string }>,
    context: Pick<AgentInstanceInfo, 'profileId' | 'workspaceSessionId'>
  ): Promise<void> {
    for (const entry of entries) {
      try {
        const rolledBack = await rollbackWorktree(entry.worktree, entry.branch)
        if (rolledBack) {
          this.emitEvent(`↩ ${entry.name} · Worktree zurückgedreht`, 'muted', context)
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        this.emitEvent(
          `⚠ ${entry.name} · Worktree konnte nicht zurückgedreht werden: ${message}`,
          'warn',
          context
        )
      }
    }
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
