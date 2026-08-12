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
 * - **Only a few event kinds are pushed from here.** `agent_exited`, because only
 *   the host can observe a process dying unasked. For PTY-only (`mcp: none`)
 *   providers the host is also the reporting channel: it parses sentinel lines
 *   into `agent_done` / `agent_progress` (and will wire `agent_question` in
 *   Task 3). The silence hint ({@link PTY_ONLY_IDLE_HINT_MS}) stays as the
 *   host-truth backstop when a sentinel agent goes quiet. MCP-attached agents
 *   still push done/question/progress only via the MCP layer — no duplicates.
 *   `agent_started` and `agent_stopped` always belong to the MCP layer.
 *
 * What the host *does* own is identity and delivery: the Commedia name, the
 * role prompt (via the provider's `systemPromptDelivery`), the worktree, the
 * window with its role colour, and typing the assignment in through the seed
 * handshake.
 */
import { randomUUID } from 'node:crypto'
import type { AgentMeta, AgentRegistry } from '@main/ipc'
import { EventQueue } from '@main/mcp/eventQueue'
import type { PendingQuestions } from '@main/mcp/pendingQuestions'
import type {
  AgentHost,
  AgentSummary,
  RetroLearningInput,
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
  seedOptionsFromProvider,
  type SeedWithReadyOptions
} from '@main/agents/interactiveReady'
import { buildReminderSuffix, type ReportingMode } from '@shared/prompts/contract'
import { buildOrchestratorSystemPrompt, type RoleWithLimit } from '@shared/prompts/orchestrator'
import type { SlotKnowledge } from '@shared/retro/runStats'
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
import { SentinelParser, type SentinelReport } from './sentinel'
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

/**
 * How long a PTY-only agent may stay silent before the orchestrator is told.
 *
 * A provider with `mcp.kind: 'none'` (today: Ollama; any future mute CLI) has
 * no MCP reporting tools. Sentinel lines are model-compliance-dependent, so
 * the silence watchdog stays as the host-truth backstop: nothing has come out
 * of that terminal for two minutes, go and look.
 */
export const PTY_ONLY_IDLE_HINT_MS = 120_000

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
  /** Retro feed: learnings in, accumulated knowledge out. Absent = no retro. */
  retro?: WorkspaceRetroFeed
}

/** The slice of the retro sink a single workspace consumes (Electron-free). */
export interface WorkspaceRetroFeed {
  recordLearnings(profile: Profile, learnings: readonly RetroLearningInput[]): { applied: number }
  knowledge(profile: Profile): SlotKnowledge[]
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
  /** Every agent — orchestrator included — works in its own worktree. */
  worktreePath: string
  /** The branch that worktree is on — the handle for baseBranch chaining. */
  branch: string
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
  /** PTY-only agents only: the pending silence watchdog. */
  idleTimer?: ReturnType<typeof setTimeout>
  /** True once this silence phase has been reported — one hint, not a drip. */
  idleNotified: boolean
  /**
   * PTY-only subagents only: incremental sentinel-line parser. Cleared on every
   * new assignment so a follow-up DONE with the same payload still fires.
   */
  sentinel?: SentinelParser
  /**
   * While Vertragus is typing into the PTY (seed handshake), echoes of
   * host-authored text must not be parsed as agent reports.
   */
  suppressSentinel: boolean
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
  /** Open-question registry from MCP registration — needed for sentinel ASK. */
  private questions: PendingQuestions | undefined
  private closed = false
  /** The record_retro summary, held until the manager finalizes the run at stop. */
  pendingRetroSummary: string | undefined

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
    return {
      agentId: record.agentId,
      name: record.name,
      role: record.roleId,
      providerId: record.providerId,
      model: record.model,
      worktreePath: record.worktreePath,
      branch: record.branch
    }
  }

  /** Hand over the URLs the MCP server minted for this workspace. */
  attachMcp(urls: WorkspaceMcpUrls): void {
    this.mcpUrls = urls
  }

  /**
   * Hand over the workspace's {@link PendingQuestions} registry after
   * `mcp.registerWorkspace`. Sentinel ASK lines create entries here so the
   * orchestrator can answer them with `send_to_agent{questionId}` exactly like
   * MCP-tool questions.
   */
  attachQuestions(questions: PendingQuestions): void {
    this.questions = questions
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
    const retro = this.deps.retro
    return {
      workspaceId: this.workspaceId,
      workspaceName: this.name,
      repoPath: this.repoPath,
      orchToken: this.orchToken,
      subToken: this.subToken,
      host: this,
      events: this.events,
      limits: this.limits(),
      roles: profileRoleIds(this.profile),
      ...(retro
        ? {
            retro: {
              recordLearnings: (learnings: readonly RetroLearningInput[]) =>
                retro.recordLearnings(this.profile, learnings),
              recordSummary: (summary: string) => {
                this.pendingRetroSummary = summary
              }
            }
          }
        : {})
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
    let spawned: SpawnedAgent | undefined

    try {
      // Always isolated: every agent gets its own worktree and branch, so
      // parallel agents — and parallel workspaces on the same repository —
      // never trample each other's checkout. Merging stays an ordinary
      // git merge of vertragus/* branches, and `baseBranch` lets an agent
      // start on top of another agent's result instead of the repo HEAD.
      const worktree = await this.createWorktreeFor(agentId, name, input.baseBranch)

      const model = input.model?.trim() || slot.model
      const launchInput: AgentLaunchInput = {
        kind: 'subagent',
        provider,
        model,
        effort: slot.effort,
        // Subagents default to yolo — a worker that cannot act is the old
        // repo's "permission-starved" failure. The orchestrator never gets it.
        yolo: this.deps.yoloMaster ?? true,
        cwd: worktree.path,
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
        worktreePath: worktree.path,
        branch: worktree.branch,
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
        providerId: provider.id,
        model,
        worktreePath: worktree.path,
        branch: worktree.branch
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
    // A new assignment resets the "has it confirmed?" question — and the
    // sentinel dedup memory, so a legitimate identical DONE for a follow-up
    // still fires. Seed echoes were suppressed during the write; reset drops
    // any partial buffer state before the agent speaks again.
    record.assignmentCursor = this.events.cursor
    record.sentinel?.reset()
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
   * The worktrees of every agent whose process is still alive — orchestrator
   * included. This is what the panel's cleanup view must NOT offer for
   * removal; everything else under the worktree root is fair game.
   */
  activeWorktreePaths(): string[] {
    return [...this.agents.values()]
      .filter((record) => record.pty.isAlive && !record.stopped)
      .map((record) => record.worktreePath)
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
        branch: record.branch,
        lastOutputAgeSec: Math.max(0, Math.round((now - record.lastOutputAt) / 1_000)),
        reporting: this.reportingForProvider(record.providerId)
      }))
  }

  /**
   * Reporting dialect for a *new* agent of this role — used by `start_agent`
   * before the agent exists. Derived from the profile slot's provider.
   */
  reportingMode(role: string): ReportingMode {
    const slot = this.profile.slots.find((candidate) => candidate.roleId === role)
    if (!slot) return 'mcp'
    return this.reportingForProvider(slot.providerId)
  }

  // --- Orchestrator ------------------------------------------------------

  /**
   * Start the workspace's orchestrator: bronze, never yolo, and carrying the
   * orchestrator system prompt through whatever delivery its provider declares
   * (a launch flag for Claude, the seed handshake for a PTY-only CLI).
   *
   * The orchestrator gets its own worktree like every other agent: it never
   * edits files itself, but its CLI still leaves per-agent artefacts in its
   * working directory (Kimi's `.kimi-code/mcp.json`), and two orchestrators
   * sharing the main checkout would overwrite each other's.
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
      maxSubagents: this.profile.maxSubagents,
      knowledge: this.deps.retro?.knowledge(this.profile) ?? []
    })

    let spawned: SpawnedAgent | undefined
    try {
      const worktree = await this.createWorktreeFor(agentId, name)

      spawned = await (this.deps.spawn ?? spawnAgent)({
        kind: 'orchestrator',
        provider,
        model: this.profile.orchestrator.model,
        effort: this.profile.orchestrator.effort,
        // Not "yolo: false because the profile says so" — an orchestrator has
        // no yolo surface at all; buildAgentArgv drops it for this kind.
        yolo: false,
        cwd: worktree.path,
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
        worktreePath: worktree.path,
        branch: worktree.branch,
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
      return {
        agentId,
        name,
        role: ORCHESTRATOR_ROLE_ID,
        providerId: provider.id,
        model: this.profile.orchestrator.model,
        worktreePath: worktree.path,
        branch: worktree.branch
      }
    } catch (error) {
      this.orchestratorRecord = undefined
      this.discard(agentId, name, spawned?.pty)
      throw error
    }
  }

  /**
   * The one worktree seam: `<repo>/.vertragus/worktrees/<agentId>` on the
   * branch `vertragus/<workspace>/<agent>`. Orchestrator and subagents both
   * pass through here — no spawn path can put an agent into a shared checkout.
   * `startPoint` is the orchestrator's `baseBranch`: the ref the new branch
   * forks from instead of the repo HEAD.
   */
  private createWorktreeFor(
    agentId: string,
    agentName: string,
    startPoint?: string
  ): Promise<CreatedWorktree> {
    return (this.deps.createWorktree ?? createWorktree)(
      this.repoPath,
      agentId,
      worktreeBranchName(this.name, agentName),
      { ...this.deps.worktreeDeps, ...(startPoint ? { startPoint } : {}) }
    )
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
    worktreePath: string
    branch: string
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
      branch: input.branch,
      pty: input.pty,
      orchestrator: input.orchestrator === true,
      seeded: false,
      stopping: false,
      stopped: false,
      lastOutputAt: this.now(),
      assignmentCursor: this.events.cursor,
      unsubscribe: [],
      idleNotified: false,
      suppressSentinel: false
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
      record.pty.onData((data) => {
        record.lastOutputAt = this.now()
        // Output ends the silence phase: the next one earns its own hint.
        record.idleNotified = false
        this.armIdleHint(record)
        if (record.sentinel && !record.suppressSentinel) {
          for (const report of record.sentinel.feed(data)) {
            this.handleSentinelReport(record, report)
          }
        }
      })
    )
    record.unsubscribe.push(record.pty.onExit((info) => this.handleExit(record, info)))
    this.agents.set(record.agentId, record)
    if (!record.orchestrator && this.isPtyOnly(record.providerId)) {
      record.sentinel = new SentinelParser()
    }
    this.armIdleHint(record)
    return record
  }

  /** `mcp.kind === 'none'` → sentinel lines; anything else → MCP tools. */
  private reportingForProvider(providerId: string): ReportingMode {
    return this.isPtyOnly(providerId) ? 'sentinel' : 'mcp'
  }

  /**
   * Turn a parsed sentinel report into the same event shapes MCP tools push.
   */
  private handleSentinelReport(record: AgentRecord, report: SentinelReport): void {
    if (this.events.isClosed || record.orchestrator) return
    const identity = {
      agentId: record.agentId,
      name: record.name,
      roleId: record.roleId
    }
    switch (report.kind) {
      case 'done':
        this.events.push({
          type: 'agent_done',
          ...identity,
          summary: report.summary,
          status: report.status
        })
        return
      case 'progress':
        this.events.push({ type: 'agent_progress', ...identity, note: report.note })
        return
      case 'unparseable':
        this.events.push({
          type: 'agent_progress',
          ...identity,
          note: `unparseable sentinel line (${report.reason})`
        })
        return
      case 'ask': {
        if (!this.questions) {
          // Wiring bug: WorkspaceManager always attachQuestions. Surface it.
          this.events.push({
            type: 'agent_progress',
            ...identity,
            note: 'sentinel ASK ignored: questions registry not attached'
          })
          return
        }
        // One open question at a time — same rule as ask_orchestrator.
        if (this.questions.openForAgent(record.agentId)) return
        const agentId = record.agentId
        const pending = this.questions.create(agentId, report.question, {
          // Reminder lives HERE only. send_to_agent{questionId} must not append
          // a second one when it awaits deliverAnswer.
          deliverAnswer: async (answer: string) => {
            await this.sendToAgent(
              agentId,
              `${answer}\n\n${buildReminderSuffix('sentinel')}`
            )
          }
        })
        this.events.push({
          type: 'agent_question',
          ...identity,
          questionId: pending.questionId,
          question: report.question
        })
        return
      }
    }
  }

  /** True for a provider that declared `mcp: none` — reports via sentinel lines. */
  private isPtyOnly(providerId: string): boolean {
    return (
      this.deps.providers.find((candidate) => candidate.id === providerId)?.mcp.kind === 'none'
    )
  }

  /**
   * (Re)start one agent's silence watchdog.
   *
   * Only for PTY-only SUBAGENTS: the orchestrator is the reader of these
   * events, not a subject of them — the same reason `handleExit` skips it. The
   * timer is unref'd so a quiet workspace never keeps the app alive.
   */
  private armIdleHint(record: AgentRecord): void {
    if (record.orchestrator || !this.isPtyOnly(record.providerId)) return
    if (record.idleTimer) clearTimeout(record.idleTimer)
    const timer = setTimeout(() => this.emitIdleHint(record), PTY_ONLY_IDLE_HINT_MS)
    ;(timer as { unref?: () => void }).unref?.()
    record.idleTimer = timer
  }

  private clearIdleHint(record: AgentRecord): void {
    if (record.idleTimer) clearTimeout(record.idleTimer)
    record.idleTimer = undefined
  }

  /**
   * The hint itself. Deliberately says "unconfirmed", not "stuck": the agent
   * may well be working. What the orchestrator is told is what read_output can
   * settle — and it is told exactly once per silence phase, because a
   * repeating alarm about a healthy long-running worker is noise it will learn
   * to ignore.
   */
  private emitIdleHint(record: AgentRecord): void {
    record.idleTimer = undefined
    if (record.idleNotified || this.events.isClosed) return
    const status = this.statusOf(record)
    if (status === AGENT_STATUS.exited || status === AGENT_STATUS.stopped) return
    // A fake clock (or a timer that fired early) must not produce a false hint.
    if (this.now() - record.lastOutputAt < PTY_ONLY_IDLE_HINT_MS) {
      this.armIdleHint(record)
      return
    }
    record.idleNotified = true
    this.events.push({
      type: 'agent_progress',
      agentId: record.agentId,
      name: record.name,
      roleId: record.roleId,
      note: `${record.name} (PTY-only): ${Math.round(
        PTY_ONLY_IDLE_HINT_MS / 1_000
      )} s ohne Ausgabe — Status unbestätigt, ggf. read_output prüfen`
    })
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
   *
   * Sentinel parsing is suppressed for the whole write: the CLI echoes
   * host-authored text (tasks, answers, reminders) and those echoes must not
   * become fake agent_done / agent_question events.
   */
  private seed(record: AgentRecord, text: string, autoSubmit: boolean): Promise<boolean> {
    const seed = this.deps.seed ?? seedWithReadyHandshake
    const provider = this.deps.providers.find((candidate) => candidate.id === record.providerId)
    record.suppressSentinel = true
    // Provider seed tuning (e.g. Cursor's longer submitDelayMs) applies first;
    // deps.seedOptions override so tests can keep the suite fast.
    return seed(
      (data) => record.pty.write(data),
      () => ({ buffer: record.pty.snapshot(), alive: record.pty.isAlive }),
      text,
      { ...seedOptionsFromProvider(provider?.seed), ...this.deps.seedOptions, autoSubmit }
    ).finally(() => {
      record.suppressSentinel = false
    })
  }

  /** Profile switch "send assignments automatically"; default on. */
  private get autoSubmitTasks(): boolean {
    return this.profile.autoSubmitTasks ?? true
  }

  /**
   * Process-death event. `confirmed` is derived, not tracked by a callback: an
   * `agent_done` newer than the agent's last assignment is proof it reported
   * before dying — whether that done came from MCP tools or a PTY sentinel.
   * Anything else — a crash, a `/exit`, an OOM kill — is `confirmed: false`.
   *
   * Cancels open questions for every agent (MCP and sentinel): a dead agent's
   * ask is unanswerable. On the stop path `terminate()` also cancels, because
   * it unsubscribes `onExit` before the async kill finishes — this line alone
   * would not run then.
   */
  private handleExit(record: AgentRecord, info: PtyExitInfo): void {
    record.exit = info
    // A dead process is not a silent one — its exit event says everything.
    this.clearIdleHint(record)
    this.questions?.cancelForAgent(record.agentId)
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
    this.clearIdleHint(record)
    // Cancel here too: pty.kill() is async and we unsubscribe onExit below, so
    // handleExit's cancelForAgent would not run on the stop path.
    this.questions?.cancelForAgent(record.agentId)
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
