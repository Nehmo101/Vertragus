/**
 * One running workspace: the bridge between the MCP tools and the real world of
 * processes and windows.
 *
 * A {@link Workspace} is the {@link AgentHost} implementation from
 * `mcp/types` — `start_agent` lands in {@link Workspace.startAgent}, and from
 * there it is PTYs, CLI windows, names and worktrees. Everything above it
 * (limits, contracts, questions, event pushes) belongs to the MCP layer, and
 * this class deliberately does none of it:
 *
 * - **Limits are NOT enforced here.** `toolsOrchestrator.start_agent` checks
 *   `perRole` and `maxTotal` against `listAgents()` before it ever calls the
 *   host. A second check here would drift from the first and produce two
 *   different error messages for one condition.
 * - **The task contract is NOT appended here.** `start_agent` composes
 *   `task + buildTaskContract()`, so a spawn path cannot forget it. The host
 *   receives the finished seed text in `StartAgentInput.task`.
 * - **Only one event kind is pushed from here: `agent_exited`.** That is the
 *   host's exclusive event per `mcp/types`, because only the host can observe a
 *   process dying unasked. `agent_started`, `agent_stopped`, `agent_done`,
 *   `agent_question` and `agent_progress` all belong to the MCP layer.
 *
 * What the host *does* own is identity and delivery: the Commedia name, the
 * role prompt (via the provider's `systemPromptDelivery`), the worktree, the
 * window with its role colour, and typing the assignment in through the seed
 * handshake.
 */
import { randomUUID } from 'node:crypto'
import type { AgentMeta, AgentRegistry } from '@main/ipc'
import { EventQueue } from '@main/mcp/eventQueue'
import type {
  AgentHost,
  AgentSummary,
  StartAgentInput,
  StartedAgent,
  WorkspaceLimits,
  WorkspaceMcpContext
} from '@main/mcp/types'
import { NameAllocator } from '@main/agents/names'
import type { PtyExitInfo, Unsubscribe } from '@main/agents/PtyAgent'
import { spawnAgent, type AgentLaunchInput, type AgentPty, type SpawnedAgent } from '@main/agents/spawn'
import {
  createWorktree,
  worktreeBranchName,
  type CreatedWorktree,
  type WorktreeDeps
} from '@main/agents/worktree'
import {
  seedWithReadyHandshake,
  type SeedWithReadyOptions
} from '@main/agents/interactiveReady'
import { buildOrchestratorSystemPrompt, type RoleWithLimit } from '@shared/prompts/orchestrator'
import {
  allRoleTemplates,
  ORCHESTRATOR_COLOR,
  ORCHESTRATOR_ROLE_ID,
  roleColor
} from '@shared/prompts/roles'
import {
  profileRoleIds,
  slotLimitFor,
  type Profile,
  type RoleTemplate,
  type Slot
} from '@shared/schema/profile'
import type { ProviderConfig } from '@shared/schema/provider'
import type { ZoneLayout } from '@shared/schema/zones'
import { terminalTailText } from './terminalText'

/** Agent statuses this host reports. See `mcp/types` TERMINAL_AGENT_STATUSES. */
export const AGENT_STATUS = {
  /** Process up, task not yet accepted by the CLI. */
  starting: 'starting',
  /** Seeded and alive — whether it is thinking or typing, we cannot know. */
  working: 'working',
  /** Process ended on its own. Terminal: frees its slot. */
  exited: 'exited',
  /** Ended by `stop_agent`. Terminal: frees its slot. */
  stopped: 'stopped'
} as const

/** How many characters of scrollback one output line is assumed to cost. */
const CHARS_PER_LINE = 600
const MIN_TAIL_CHARS = 8_000
const MAX_TAIL_CHARS = 400_000

/** Opening/closing the CLI window for an agent. Faked wholesale in tests. */
export interface WorkspaceWindows {
  open(
    agentId: string,
    options: {
      title: string
      roleColor: string
      /** Role + zone layout; the window layer turns this into bounds. */
      placement?: { roleId: string; zones?: ZoneLayout }
    }
  ): void
  close(agentId: string): void
}

/** The MCP URLs of this workspace, handed over after registration. */
export interface WorkspaceMcpUrls {
  orchestratorUrl: string
  subagentUrl(agentId: string): string
}

export interface WorkspaceDeps {
  registry: AgentRegistry
  windows: WorkspaceWindows
  /** Where transient MCP config files are written (app userData in production). */
  configDir: string
  /** Effective provider list (presets merged with the user's overrides). */
  providers: readonly ProviderConfig[]
  /** The user's custom role templates; merged over the built-ins. */
  roleTemplates?: readonly RoleTemplate[]
  /** Master yolo switch. Subagents are yolo when it is on; orchestrators never. */
  yoloMaster?: boolean
  spawn?: typeof spawnAgent
  createWorktree?: typeof createWorktree
  seed?: typeof seedWithReadyHandshake
  now?: () => number
  newId?: () => string
  random?: () => number
  /** Seed-handshake tuning; tests shorten it so the suite stays fast. */
  seedOptions?: SeedWithReadyOptions
  worktreeDeps?: WorktreeDeps
}

export interface WorkspaceInit {
  profile: Profile
  /** Display name from the app-wide Commedia sequence, e.g. "Purgatorio II". */
  name: string
}

interface AgentRecord {
  agentId: string
  name: string
  roleId: string
  providerId: string
  model?: string
  worktreePath?: string
  pty: AgentPty
  /** The workspace's own orchestrator — excluded from listAgents and events. */
  orchestrator: boolean
  /** True once the CLI accepted its assignment through the seed handshake. */
  seeded: boolean
  /** Set before we kill it, so its exit does not look like an unasked death. */
  stopping: boolean
  stopped: boolean
  exit?: PtyExitInfo
  lastOutputAt: number
  /**
   * Event cursor when this agent last received an assignment. An `agent_done`
   * newer than this proves the agent confirmed *this* task — which is exactly
   * the `confirmed` flag of `agent_exited`.
   */
  assignmentCursor: number
  unsubscribe: Unsubscribe[]
}

export class Workspace implements AgentHost {
  readonly workspaceId: string
  readonly name: string
  readonly profile: Profile
  readonly events: EventQueue
  readonly orchToken: string
  readonly subToken: string

  private readonly deps: WorkspaceDeps
  private readonly names: NameAllocator
  private readonly agents = new Map<string, AgentRecord>()
  private readonly now: () => number
  private readonly newId: () => string
  private orchestratorRecord: AgentRecord | undefined
  private mcpUrls: WorkspaceMcpUrls | undefined
  private closed = false

  constructor(init: WorkspaceInit, deps: WorkspaceDeps) {
    this.profile = init.profile
    this.name = init.name
    this.deps = deps
    this.now = deps.now ?? Date.now
    this.newId = deps.newId ?? randomUUID
    this.workspaceId = this.newId()
    this.orchToken = this.newId()
    this.subToken = this.newId()
    this.events = new EventQueue()
    this.names = new NameAllocator(deps.random)
  }

  get profileId(): string {
    return this.profile.id
  }

  get repoPath(): string {
    return this.profile.repoPath
  }

  /** The orchestrator, once started. Never part of {@link listAgents}. */
  get orchestrator(): StartedAgent | undefined {
    const record = this.orchestratorRecord
    if (!record) return undefined
    return { agentId: record.agentId, name: record.name, role: record.roleId }
  }

  /** Hand over the URLs the MCP server minted for this workspace. */
  attachMcp(urls: WorkspaceMcpUrls): void {
    this.mcpUrls = urls
  }

  /**
   * Per-role and total caps, derived from the profile. The MCP layer enforces
   * them; this only reports what the profile declares.
   */
  limits(): WorkspaceLimits {
    const perRole = new Map<string, number | undefined>()
    for (const roleId of profileRoleIds(this.profile)) {
      perRole.set(roleId, slotLimitFor(this.profile, roleId).max)
    }
    return { perRole, maxTotal: this.profile.maxSubagents }
  }

  /** The registration payload for `mcp/server.registerWorkspace`. */
  mcpContext(): WorkspaceMcpContext {
    return {
      workspaceId: this.workspaceId,
      workspaceName: this.name,
      repoPath: this.repoPath,
      orchToken: this.orchToken,
      subToken: this.subToken,
      host: this,
      events: this.events,
      limits: this.limits(),
      roles: profileRoleIds(this.profile)
    }
  }

  // --- AgentHost ---------------------------------------------------------

  async startAgent(input: StartAgentInput): Promise<StartedAgent> {
    this.assertOpen()
    const urls = this.requireMcp()
    const slot = this.slotFor(input.role)
    const provider = this.requireProvider(slot.providerId)
    const template = this.requireRoleTemplate(input.role)

    const agentId = this.newId()
    const name = this.names.allocate('sub')
    let worktree: CreatedWorktree | undefined
    let spawned: SpawnedAgent | undefined

    try {
      if (input.worktree) {
        worktree = await (this.deps.createWorktree ?? createWorktree)(
          this.repoPath,
          agentId,
          worktreeBranchName(this.name, name),
          this.deps.worktreeDeps
        )
      }

      const model = input.model?.trim() || slot.model
      const launchInput: AgentLaunchInput = {
        kind: 'subagent',
        provider,
        model,
        effort: slot.effort,
        // Subagents default to yolo — a worker that cannot act is the old
        // repo's "permission-starved" failure. The orchestrator never gets it.
        yolo: this.deps.yoloMaster ?? true,
        cwd: worktree?.path ?? this.repoPath,
        mcpUrl: urls.subagentUrl(agentId),
        fileTag: `sub-${agentId}`,
        configDir: this.deps.configDir,
        systemPrompt: template.prompt
      }
      spawned = await (this.deps.spawn ?? spawnAgent)(launchInput)

      const record = this.track({
        agentId,
        name,
        roleId: input.role,
        providerId: provider.id,
        model,
        worktreePath: worktree?.path,
        pty: spawned.pty
      })

      this.openWindow(record, this.colorFor(input.role))

      // `input.task` already carries the reporting contract — appended by the
      // MCP layer, see the class comment. A provider without a system-prompt
      // flag gets its role prompt typed in front of the task instead.
      const seedText = spawned.launch.ptySystemPrompt
        ? `${spawned.launch.ptySystemPrompt}\n\n${input.task}`
        : input.task
      const accepted = await this.seed(record, seedText, this.autoSubmitTasks)
      if (!accepted) {
        throw new Error(
          `${name} (${provider.label}) never became ready — the CLI did not accept its task.`
        )
      }
      record.seeded = true
      record.assignmentCursor = this.events.cursor

      return {
        agentId,
        name,
        role: input.role,
        worktreePath: worktree?.path
      }
    } catch (error) {
      // A half-started agent must not hold a name, a window or a process.
      this.discard(agentId, name, spawned?.pty)
      throw error
    }
  }

  async sendToAgent(agentId: string, text: string): Promise<void> {
    const record = this.requireAgent(agentId)
    if (!record.pty.isAlive) {
      throw new Error(`${record.name} is no longer running — its process has ended.`)
    }
    const accepted = await this.seed(record, text, this.autoSubmitTasks)
    if (!accepted) throw new Error(`${record.name} did not accept the message.`)
    // A new assignment resets the "has it confirmed?" question.
    record.assignmentCursor = this.events.cursor
  }

  async stopAgent(agentId: string): Promise<boolean> {
    const record = this.agents.get(agentId)
    if (!record) return false
    const wasRunning = record.pty.isAlive && !record.stopped
    this.terminate(record)
    // The record stays listed as `stopped`: the orchestrator is told to verify
    // with read_output, and a scrollback it can no longer reach is useless.
    return wasRunning
  }

  async readOutput(agentId: string, lines: number): Promise<string> {
    const record = this.requireAgent(agentId)
    const chars = Math.min(MAX_TAIL_CHARS, Math.max(MIN_TAIL_CHARS, lines * CHARS_PER_LINE))
    return terminalTailText(record.pty.tail(chars), lines)
  }

  /**
   * Every subagent, in start order. The orchestrator is deliberately absent: it
   * is the reader of this list, and counting it would eat one of its own slots.
   */
  listAgents(): AgentSummary[] {
    const now = this.now()
    return [...this.agents.values()]
      .filter((record) => !record.orchestrator)
      .map((record) => ({
        agentId: record.agentId,
        name: record.name,
        role: record.roleId,
        status: this.statusOf(record),
        model: record.model,
        worktreePath: record.worktreePath,
        lastOutputAgeSec: Math.max(0, Math.round((now - record.lastOutputAt) / 1_000))
      }))
  }

  // --- Orchestrator ------------------------------------------------------

  /**
   * Start the workspace's orchestrator: bronze, never yolo, and carrying the
   * orchestrator system prompt through whatever delivery its provider declares
   * (a launch flag for Claude, the seed handshake for a PTY-only CLI).
   */
  async startOrchestrator(): Promise<StartedAgent> {
    this.assertOpen()
    if (this.orchestratorRecord) throw new Error('This workspace already has an orchestrator.')
    const urls = this.requireMcp()
    const provider = this.requireProvider(this.profile.orchestrator.providerId)

    const agentId = this.newId()
    const name = this.names.allocate('orchestrator')
    const systemPrompt = buildOrchestratorSystemPrompt({
      workspaceName: this.name,
      repoPath: this.repoPath,
      rolesWithLimits: this.rolesWithLimits(),
      maxSubagents: this.profile.maxSubagents
    })

    let spawned: SpawnedAgent | undefined
    try {
      spawned = await (this.deps.spawn ?? spawnAgent)({
        kind: 'orchestrator',
        provider,
        model: this.profile.orchestrator.model,
        effort: this.profile.orchestrator.effort,
        // Not "yolo: false because the profile says so" — an orchestrator has
        // no yolo surface at all; buildAgentArgv drops it for this kind.
        yolo: false,
        cwd: this.repoPath,
        mcpUrl: urls.orchestratorUrl,
        fileTag: `orch-${agentId}`,
        configDir: this.deps.configDir,
        systemPrompt
      })

      const record = this.track({
        agentId,
        name,
        roleId: ORCHESTRATOR_ROLE_ID,
        providerId: provider.id,
        model: this.profile.orchestrator.model,
        pty: spawned.pty,
        orchestrator: true
      })
      this.orchestratorRecord = record
      this.openWindow(record, ORCHESTRATOR_COLOR)

      if (spawned.launch.ptySystemPrompt) {
        // Always submitted: this is the orchestrator's own system prompt, not
        // an assignment the user might want to edit first.
        const accepted = await this.seed(record, spawned.launch.ptySystemPrompt, true)
        if (!accepted) {
          throw new Error(
            `${name} (${provider.label}) never became ready — the orchestrator prompt was not delivered.`
          )
        }
      }
      record.seeded = true
      record.assignmentCursor = this.events.cursor
      return { agentId, name, role: ORCHESTRATOR_ROLE_ID }
    } catch (error) {
      this.orchestratorRecord = undefined
      this.discard(agentId, name, spawned?.pty)
      throw error
    }
  }

  /** Roles and their caps, as the orchestrator prompt renders them. */
  rolesWithLimits(): RoleWithLimit[] {
    const templates = allRoleTemplates(this.deps.roleTemplates ?? [])
    return profileRoleIds(this.profile).map((roleId) => ({
      id: roleId,
      description: templates.find((template) => template.id === roleId)?.name,
      max: slotLimitFor(this.profile, roleId).max
    }))
  }

  /**
   * Stop every agent, orchestrator last: it is the one that would otherwise
   * watch its whole team die and start replacing them.
   */
  async stopAll(): Promise<void> {
    for (const agentId of [...this.agents.keys()]) {
      if (agentId === this.orchestratorRecord?.agentId) continue
      await this.stopAgent(agentId)
    }
    const orchestrator = this.orchestratorRecord
    if (orchestrator) {
      this.terminate(orchestrator)
      this.orchestratorRecord = undefined
    }
  }

  /**
   * Stop everything and release the workspace. The EventQueue is NOT closed
   * here — `mcp/server.unregisterWorkspace` owns that, and closing it twice
   * would race the parked `await_events` readers it has to release.
   */
  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    await this.stopAll()
    this.agents.clear()
  }

  // --- internals ---------------------------------------------------------

  private assertOpen(): void {
    if (this.closed) throw new Error(`Workspace ${this.name} is closed.`)
  }

  private requireMcp(): WorkspaceMcpUrls {
    if (!this.mcpUrls) throw new Error(`Workspace ${this.name} is not registered with the MCP server.`)
    return this.mcpUrls
  }

  private slotFor(roleId: string): Slot {
    const slot = this.profile.slots.find((candidate) => candidate.roleId === roleId)
    if (!slot) {
      throw new Error(
        `No slot configured for role "${roleId}" in profile "${this.profile.name}".`
      )
    }
    return slot
  }

  private requireProvider(providerId: string): ProviderConfig {
    const provider = this.deps.providers.find((candidate) => candidate.id === providerId)
    if (!provider) throw new Error(`Unknown provider "${providerId}".`)
    if (!provider.enabled) throw new Error(`Provider "${provider.label}" is disabled.`)
    return provider
  }

  private requireRoleTemplate(roleId: string): RoleTemplate {
    const template = allRoleTemplates(this.deps.roleTemplates ?? []).find(
      (candidate) => candidate.id === roleId
    )
    if (!template) throw new Error(`No role template for "${roleId}".`)
    return template
  }

  private requireAgent(agentId: string): AgentRecord {
    const record = this.agents.get(agentId)
    if (!record) throw new Error(`Unknown agent ${agentId}.`)
    return record
  }

  private colorFor(roleId: string): string {
    return roleColor(roleId, profileRoleIds(this.profile).indexOf(roleId))
  }

  private statusOf(record: AgentRecord): string {
    if (record.stopped) return AGENT_STATUS.stopped
    if (record.exit || !record.pty.isAlive) return AGENT_STATUS.exited
    return record.seeded ? AGENT_STATUS.working : AGENT_STATUS.starting
  }

  private track(input: {
    agentId: string
    name: string
    roleId: string
    providerId: string
    model?: string
    worktreePath?: string
    pty: AgentPty
    orchestrator?: boolean
  }): AgentRecord {
    const record: AgentRecord = {
      agentId: input.agentId,
      name: input.name,
      roleId: input.roleId,
      providerId: input.providerId,
      model: input.model,
      worktreePath: input.worktreePath,
      pty: input.pty,
      orchestrator: input.orchestrator === true,
      seeded: false,
      stopping: false,
      stopped: false,
      lastOutputAt: this.now(),
      assignmentCursor: this.events.cursor,
      unsubscribe: []
    }
    // Registration first: the CLI window calls `terminal:attach` as soon as it
    // loads, and an unregistered agent rejects that call.
    const meta: AgentMeta = {
      agentId: record.agentId,
      name: record.name,
      role: record.roleId,
      roleColor: input.orchestrator ? ORCHESTRATOR_COLOR : this.colorFor(record.roleId),
      provider: record.providerId,
      model: record.model ?? ''
    }
    this.deps.registry.registerAgent({ pty: record.pty, meta })
    record.unsubscribe.push(
      record.pty.onData(() => {
        record.lastOutputAt = this.now()
      })
    )
    record.unsubscribe.push(record.pty.onExit((info) => this.handleExit(record, info)))
    this.agents.set(record.agentId, record)
    return record
  }

  private openWindow(record: AgentRecord, color: string): void {
    // Where the window lands is decided by the placement layer (zones first,
    // auto-tiling otherwise) — this host only says which role it is and what
    // the profile's layout looks like, so it stays Electron-free.
    this.deps.windows.open(record.agentId, {
      title: record.name,
      roleColor: color,
      placement: {
        roleId: record.orchestrator ? ORCHESTRATOR_ROLE_ID : record.roleId,
        ...(this.profile.zones ? { zones: this.profile.zones } : {})
      }
    })
  }

  /**
   * Type text into an agent's CLI.
   *
   * `autoSubmit` decides whether the submitting Enter follows. It is a
   * parameter and not a property because the two callers differ: an
   * *assignment* obeys the profile (the user may want to redact it before it
   * runs), while a system prompt that has no launch flag is plumbing the user
   * never asked to see and is always sent.
   */
  private seed(record: AgentRecord, text: string, autoSubmit: boolean): Promise<boolean> {
    const seed = this.deps.seed ?? seedWithReadyHandshake
    return seed(
      (data) => record.pty.write(data),
      () => ({ buffer: record.pty.snapshot(), alive: record.pty.isAlive }),
      text,
      { ...this.deps.seedOptions, autoSubmit }
    )
  }

  /** Profile switch "send assignments automatically"; default on. */
  private get autoSubmitTasks(): boolean {
    return this.profile.autoSubmitTasks ?? true
  }

  /**
   * The host's ONE event. `confirmed` is derived, not tracked by a callback:
   * an `agent_done` newer than the agent's last assignment is proof it reported
   * before dying. Anything else — a crash, a `/exit`, an OOM kill — is
   * `confirmed: false`, which is the orchestrator's cue to read_output instead
   * of assuming success.
   */
  private handleExit(record: AgentRecord, info: PtyExitInfo): void {
    record.exit = info
    if (record.stopping) return
    if (record.orchestrator) return
    if (this.events.isClosed) return
    this.events.push({
      type: 'agent_exited',
      agentId: record.agentId,
      name: record.name,
      roleId: record.roleId,
      exitCode: info.exitCode ?? null,
      confirmed: this.hasConfirmedSinceAssignment(record)
    })
  }

  private hasConfirmedSinceAssignment(record: AgentRecord): boolean {
    return this.events
      .all()
      .some(
        (event) =>
          event.type === 'agent_done' &&
          event.agentId === record.agentId &&
          event.seq > record.assignmentCursor
      )
  }

  /** Kill chain plus window and name release — the shared part of stop/close. */
  private terminate(record: AgentRecord): void {
    record.stopping = true
    record.stopped = true
    record.pty.kill()
    for (const off of record.unsubscribe) off()
    record.unsubscribe = []
    this.deps.registry.removeAgent(record.agentId)
    this.deps.windows.close(record.agentId)
    this.names.release(record.name)
  }

  /** Undo a partial start: no orphan process, no held name, no stray window. */
  private discard(agentId: string, name: string, pty: AgentPty | undefined): void {
    const record = this.agents.get(agentId)
    if (record) {
      this.terminate(record)
      this.agents.delete(agentId)
      return
    }
    pty?.kill()
    this.deps.registry.removeAgent(agentId)
    this.deps.windows.close(agentId)
    this.names.release(name)
  }
}
