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
 *   different error messages for one condition. What the host contributes is
 *   the *reservation*: {@link Workspace.beginAgent} synchronously claims a
 *   slot (the agent appears in `listAgents` as `starting` before anything is
 *   awaited), so the tool's check-then-begin runs in one synchronous block
 *   and two concurrent `start_agent` calls cannot both pass a cap of one.
 *   Per-slot capacity IS resolved here ({@link Workspace.slotWithCapacity}) —
 *   which provider/model an agent gets is host business.
 * - **The task contract is NOT appended here.** `start_agent` composes
 *   `task + buildTaskContract()`, so a spawn path cannot forget it. The host
 *   receives the finished seed text in `StartAgentInput.task`.
 * - **Only a few event kinds are pushed from here.** `agent_exited` and
 *   `orchestrator_exited`, because only the host can observe a process dying
 *   unasked. For PTY-only (`mcp: none`)
 *   providers the host is also the reporting channel: it parses sentinel lines
 *   into `agent_done` / `agent_progress` / `agent_question`. The silence hint
 *   ({@link PTY_ONLY_IDLE_HINT_MS}) stays as the
 *   host-truth backstop when a sentinel agent goes quiet. MCP-attached agents
 *   still push done/question/progress only via the MCP layer — no duplicates.
 *   `agent_started` and `agent_stopped` always belong to the MCP layer.
 *   Sentinel `agent_done` is host-owned and carries worktree facts when git
 *   answers; MCP `report_done` attaches the same facts in the tool layer.
 *
 * What the host *does* own is identity and delivery: the Commedia name, the
 * role prompt (via the provider's `systemPromptDelivery`), the worktree, the
 * window with its role colour, and typing the assignment in through the seed
 * handshake.
 */
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { AgentMeta, AgentRegistry } from '@main/ipc'
import { EventQueue } from '@main/mcp/eventQueue'
import type { PendingQuestions } from '@main/mcp/pendingQuestions'
import {
  USER_QUESTION_AGENT_ID,
  worktreeEventFields,
  type AgentHost,
  type IntegrateOutcome,
  type StartLeadInput,
  type WorkspaceBudget,
  type AgentSummary,
  type InspectAgentOptions,
  type InspectAgentResult,
  type RetroLearningInput,
  type StartAgentInput,
  type StartedAgent,
  type StartingAgent,
  type WorktreeFacts,
  type WorkspaceLimits,
  type WorkspaceMcpContext
} from '@main/mcp/types'
import { NameAllocator } from '@main/agents/names'
import type { PtyExitInfo, Unsubscribe } from '@main/agents/PtyAgent'
import { spawnAgent, type AgentLaunchInput, type AgentPty, type SpawnedAgent } from '@main/agents/spawn'
import { inspectWorktree, snapshotWorktree } from '@main/agents/inspectWorktree'
import {
  commitWorktree,
  createWorktree,
  defaultGitRunner,
  mergeBranchIntoWorktree,
  worktreeBranchName,
  worktreePathFor,
  type CreatedWorktree,
  type WorktreeDeps
} from '@main/agents/worktree'
import {
  seedWithReadyHandshake,
  seedOptionsFromProvider,
  type SeedWithReadyOptions
} from '@main/agents/interactiveReady'
import type { AgentPolicy } from '@shared/agentPolicy'
import { buildReminderSuffix, type ReportingMode } from '@shared/prompts/contract'
import {
  buildLeadSystemPrompt,
  buildOrchestratorSystemPrompt,
  type RoleWithLimit
} from '@shared/prompts/orchestrator'
import type { SlotKnowledge } from '@shared/retro/runStats'
import {
  allRoleTemplates,
  LEAD_COLOR,
  LEAD_ROLE_ID,
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
import type { AgentDoneStatus } from '@shared/schema/events'
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

/**
 * C5: how long the orchestrator may go without calling ANY of its MCP tools
 * before the host reports `orchestrator_idle`. Must sit well above the ~55 s
 * `await_events` long-poll ceiling — a parked poll touches the watchdog only
 * when it returns, and that must never count as idle.
 */
export const ORCHESTRATOR_IDLE_MS = 120_000

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
  /** F: the MCP URL a lead process attaches with (`lead=` identity). */
  leadUrl(agentId: string): string
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
  /**
   * D4: the three-tier policy. Wins over `yoloMaster` when set; absent falls
   * back to the boolean (on = `yolo`, off = `ask-user`) so old callers keep
   * their behavior. Only subagents are governed — orchestrators and leads
   * have no yolo surface under any tier.
   */
  agentPolicy?: AgentPolicy
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
  /**
   * E3: pre-built briefing about the run this workspace resumes — shown first
   * in the orchestrator's repository briefing. Absent = a fresh run.
   */
  resumeBriefing?: string
}

/** The slice of the retro sink a single workspace consumes (Electron-free). */
export interface WorkspaceRetroFeed {
  recordLearnings(profile: Profile, learnings: readonly RetroLearningInput[]): { applied: number }
  knowledge(profile: Profile): SlotKnowledge[]
  /** E2: durable repo facts for the orchestrator briefing; optional for old fakes. */
  repoNotes?(profile: Profile): string[]
  recordRepoNotes?(profile: Profile, notes: readonly string[]): { applied: number }
}

export interface WorkspaceInit {
  profile: Profile
  /** Display name from the app-wide Commedia sequence, e.g. "Purgatorio II". */
  name: string
}

/**
 * A slot reservation made by {@link Workspace.beginAgent} before anything is
 * awaited. Counts toward the slot exactly like a tracked record, so the limit
 * check in `start_agent` sees the agent the moment `beginAgent` returns.
 */
interface PendingStart {
  agentId: string
  name: string
  roleId: string
  /** Absent for leads — they occupy no profile slot. */
  slotId?: string
  providerId: string
  model?: string
  worktreePath: string
  branch: string
  /** F: reserved by beginLead. */
  lead?: boolean
}

interface AgentRecord {
  agentId: string
  name: string
  roleId: string
  /** Which profile slot this agent occupies; orchestrators have none. */
  slotId?: string
  providerId: string
  model?: string
  /** Every agent — orchestrator included — works in its own worktree. */
  worktreePath: string
  /** The branch that worktree is on — the handle for baseBranch chaining. */
  branch: string
  pty: AgentPty
  /** The workspace's own orchestrator — excluded from listAgents and events. */
  orchestrator: boolean
  /** F: a sub-orchestrator started via start_orchestrator. Listed like a subagent. */
  lead: boolean
  /** True once the CLI accepted its assignment through the seed handshake. */
  seeded: boolean
  /** Set before we kill it, so its exit does not look like an unasked death. */
  stopping: boolean
  stopped: boolean
  exit?: PtyExitInfo
  lastOutputAt: number
  /** E4: wall-clock bookkeeping — when this agent started and (maybe) ended. */
  startedAt: number
  endedAt?: number
  /**
   * Event cursor when this agent last received an assignment. An `agent_done`
   * newer than this proves the agent confirmed *this* task — which is exactly
   * the `confirmed` flag of `agent_exited`.
   */
  assignmentCursor: number
  /**
   * True once a sentinel DONE landed for the current assignment. Snapshotting
   * the worktree is async, so `agent_done` may not be in the queue yet when
   * the process exits — this flag still confirms the exit.
   */
  doneSinceAssignment: boolean
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

/** Max summary characters carried into a snapshot-commit subject line. */
const SNAPSHOT_SUBJECT_MAX = 120

/**
 * C3 commit message: `vertragus: <agent> / <role> — <first line of the
 * summary>`. Exported so the format is pinned by a test — reviewers grep for
 * these commits.
 */
export function snapshotCommitMessage(agentName: string, roleId: string, summary: string): string {
  const firstLine =
    summary
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? ''
  const capped =
    firstLine.length <= SNAPSHOT_SUBJECT_MAX
      ? firstLine
      : `${firstLine.slice(0, SNAPSHOT_SUBJECT_MAX - 1)}…`
  return `vertragus: ${agentName} / ${roleId}${capped ? ` — ${capped}` : ''}`
}

/** Resolve once the PTY's process has exited, or after `timeoutMs` — never rejects. */
function awaitPtyExit(pty: AgentPty, timeoutMs: number): Promise<void> {
  if (!pty.isAlive) return Promise.resolve()
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      off()
      resolve()
    }, timeoutMs)
    ;(timer as { unref?: () => void }).unref?.()
    const off = pty.onExit(() => {
      clearTimeout(timer)
      resolve()
    })
  })
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
  private readonly pendingStarts = new Map<string, PendingStart>()
  private readonly now: () => number
  private readonly newId: () => string
  private orchestratorRecord: AgentRecord | undefined
  private mcpUrls: WorkspaceMcpUrls | undefined
  /** Open-question registry from MCP registration — needed for sentinel ASK. */
  private questions: PendingQuestions | undefined
  /**
   * F: routes an event ABOUT an agent to its parent's queue (a lead's child →
   * the lead queue). Installed by the WorkspaceManager after registration;
   * without it everything lands in the root queue (flat workspace).
   */
  private eventRouter: ((agentId: string) => EventQueue) | undefined
  private closed = false
  /** The record_retro summary, held until the manager finalizes the run at stop. */
  pendingRetroSummary: string | undefined
  /** The user's goal, once it was DELIVERED to the orchestrator (H2). */
  private goal: string | undefined
  /** C5 idle watchdog: when the orchestrator last called one of its tools. */
  private orchestratorLastToolAt = 0
  private orchestratorIdleTimer: ReturnType<typeof setTimeout> | undefined
  /** True while the current silence phase has been reported — one event, not a drip. */
  private orchestratorIdleNotified = false

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

  /**
   * True while the orchestrator process is up. The panel derives the
   * workspace's `active` flag from this — a crashed orchestrator must grey the
   * card out instead of pretending the workspace still drives itself.
   */
  get orchestratorAlive(): boolean {
    const record = this.orchestratorRecord
    if (!record) return false
    return record.pty.isAlive && !record.stopped && record.exit === undefined
  }

  /**
   * The goal this workspace was started with — set only after
   * {@link assignGoal} actually delivered it to the orchestrator's CLI, so the
   * panel and the remote client never show a goal the orchestrator never saw.
   * Undefined for a bare Play (back-compat): the UI shows "no goal" instead.
   */
  get goalText(): string | undefined {
    return this.goal
  }

  /**
   * C5: true while the orchestrator process lives but has not called any of
   * its tools for {@link ORCHESTRATOR_IDLE_MS} — the reported silence phase.
   * The panel and the remote client derive their idle hint from this.
   */
  get orchestratorIdle(): boolean {
    return this.orchestratorIdleNotified && this.orchestratorAlive
  }

  /**
   * C5: the MCP layer reports an orchestrator tool call (entry and exit).
   * Ends any reported silence phase and re-arms the watchdog.
   */
  noteOrchestratorActivity(): void {
    this.orchestratorLastToolAt = this.now()
    this.orchestratorIdleNotified = false
    this.armOrchestratorIdleWatchdog()
  }

  private armOrchestratorIdleWatchdog(): void {
    if (this.closed || !this.orchestratorAlive) return
    if (this.orchestratorIdleTimer) clearTimeout(this.orchestratorIdleTimer)
    const timer = setTimeout(() => this.emitOrchestratorIdle(), ORCHESTRATOR_IDLE_MS)
    ;(timer as { unref?: () => void }).unref?.()
    this.orchestratorIdleTimer = timer
  }

  private clearOrchestratorIdleWatchdog(): void {
    if (this.orchestratorIdleTimer) clearTimeout(this.orchestratorIdleTimer)
    this.orchestratorIdleTimer = undefined
  }

  /**
   * The watchdog fired. Deliberately does NOT wake the orchestrator — it is
   * the one reader that stopped reading; the event is for the panel, the
   * remote client and the history. One reminder line goes into its terminal
   * (display only, no input), once per silence phase.
   */
  private emitOrchestratorIdle(): void {
    this.orchestratorIdleTimer = undefined
    const record = this.orchestratorRecord
    if (!record || !this.orchestratorAlive || this.orchestratorIdleNotified) return
    if (this.events.isClosed) return
    const idleMs = this.now() - this.orchestratorLastToolAt
    // A timer that fired early (fake clocks, drift) re-arms instead of lying.
    if (idleMs < ORCHESTRATOR_IDLE_MS) {
      this.armOrchestratorIdleWatchdog()
      return
    }
    this.orchestratorIdleNotified = true
    this.events.push({
      type: 'orchestrator_idle',
      agentId: record.agentId,
      name: record.name,
      roleId: record.roleId,
      idleSec: Math.round(idleMs / 1_000)
    })
    record.pty.push(
      `\r\n\x1b[33mVertragus: no orchestrator tool call for ${Math.round(
        idleMs / 1_000
      )} s — the loop looks idle. Continue with await_events.\x1b[0m\r\n`
    )
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

  /** F: install the MCP layer's parent-queue router (see {@link queueFor}). */
  attachEventRouter(router: (agentId: string) => EventQueue): void {
    this.eventRouter = router
  }

  /** The queue an event about `agentId` belongs in — its parent's, else root. */
  private queueFor(agentId: string): EventQueue {
    return this.eventRouter?.(agentId) ?? this.events
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

  /** D4: the tier subagents run under — the stored policy, else the legacy bool. */
  private agentPolicy(): AgentPolicy {
    return this.deps.agentPolicy ?? ((this.deps.yoloMaster ?? true) ? 'yolo' : 'ask-user')
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
      agentPolicy: this.agentPolicy(),
      ...(retro
        ? {
            retro: {
              recordLearnings: (learnings: readonly RetroLearningInput[]) =>
                retro.recordLearnings(this.profile, learnings),
              recordSummary: (summary: string) => {
                this.pendingRetroSummary = summary
              },
              // E2: durable repo facts, fed into the next run's briefing.
              recordRepoNotes: (notes: readonly string[]) =>
                retro.recordRepoNotes?.(this.profile, notes) ?? { applied: 0 }
            }
          }
        : {})
    }
  }

  // --- AgentHost ---------------------------------------------------------

  beginAgent(input: StartAgentInput): StartingAgent {
    this.assertOpen()
    const urls = this.requireMcp()
    // Everything that can refuse, refuses BEFORE the reservation — a begin
    // that throws must not leak a name or a claimed slot.
    const slot = this.slotWithCapacity(input.role, {
      slotId: input.slotId,
      providerId: input.providerId
    })
    const provider = this.requireProvider(slot.providerId)
    const template = this.requireRoleTemplate(input.role)

    const agentId = this.newId()
    const name = this.names.allocate('sub')
    const model = input.model?.trim() || slot.model
    const pending: PendingStart = {
      agentId,
      name,
      roleId: input.role,
      slotId: slot.id,
      providerId: provider.id,
      model,
      // Both are decided by convention, not by the worktree call — which is
      // what lets `beginAgent` answer before git ran. `finishStart` uses the
      // real worktree result for the record; a mismatch would be a bug in
      // `createWorktree`, and its own tests pin the convention.
      worktreePath: worktreePathFor(this.repoPath, agentId),
      branch: worktreeBranchName(this.name, name)
    }
    this.pendingStarts.set(agentId, pending)

    return {
      agentId,
      name,
      role: input.role,
      providerId: provider.id,
      model,
      worktreePath: pending.worktreePath,
      branch: pending.branch,
      ready: this.finishStart(pending, slot, provider, template, input, urls)
    }
  }

  /** Test/live convenience: begin an agent and wait for the whole pipeline. */
  async startAgent(input: StartAgentInput): Promise<StartedAgent> {
    const begun = this.beginAgent(input)
    await begun.ready
    return begun
  }

  /**
   * F: reserve and begin one LEAD start. Same reservation discipline as
   * {@link beginAgent}; no profile slot (the global cap is checked by the
   * tool layer), the profile's orchestrator provider, an orchestrator-kind
   * name, never yolo, darker bronze, and a `lead=` MCP URL.
   */
  beginLead(input: StartLeadInput): StartingAgent {
    this.assertOpen()
    const urls = this.requireMcp()
    const provider = this.requireProvider(this.profile.orchestrator.providerId)

    const agentId = this.newId()
    const name = this.names.allocate('orchestrator')
    const model = input.model?.trim() || this.profile.orchestrator.model
    const pending: PendingStart = {
      agentId,
      name,
      roleId: LEAD_ROLE_ID,
      providerId: provider.id,
      model,
      worktreePath: worktreePathFor(this.repoPath, agentId),
      branch: worktreeBranchName(this.name, name),
      lead: true
    }
    this.pendingStarts.set(agentId, pending)

    return {
      agentId,
      name,
      role: LEAD_ROLE_ID,
      providerId: provider.id,
      model,
      worktreePath: pending.worktreePath,
      branch: pending.branch,
      ready: this.finishLeadStart(pending, provider, input, urls)
    }
  }

  /** Test/live convenience: begin a lead and wait for the whole pipeline. */
  async startLead(input: StartLeadInput): Promise<StartedAgent> {
    const begun = this.beginLead(input)
    await begun.ready
    return begun
  }

  /** The heavy half of {@link beginLead} — mirrors {@link finishStart}. */
  private async finishLeadStart(
    pending: PendingStart,
    provider: ProviderConfig,
    input: StartLeadInput,
    urls: WorkspaceMcpUrls
  ): Promise<void> {
    let spawned: SpawnedAgent | undefined
    try {
      const worktree = await this.createWorktreeFor(pending.agentId, pending.name, input.baseBranch)
      this.assertOpenDuringStart(pending)

      const systemPrompt = buildLeadSystemPrompt({
        workspaceName: this.name,
        repoPath: this.repoPath,
        rolesWithLimits: this.rolesWithLimits(),
        maxSubagents: this.profile.maxSubagents,
        area: input.area,
        parentName: this.orchestratorRecord?.name,
        subtreeBudget: input.maxSubagents
      })
      spawned = await (this.deps.spawn ?? spawnAgent)({
        kind: 'lead',
        provider,
        model: pending.model,
        effort: this.profile.orchestrator.effort,
        // Like the root: a lead has no yolo surface at all.
        yolo: false,
        cwd: worktree.path,
        mcpUrl: urls.leadUrl(pending.agentId),
        fileTag: `lead-${pending.agentId}`,
        configDir: this.deps.configDir,
        systemPrompt
      })
      this.assertOpenDuringStart(pending)

      const record = this.track({
        agentId: pending.agentId,
        name: pending.name,
        roleId: LEAD_ROLE_ID,
        providerId: provider.id,
        model: pending.model,
        worktreePath: worktree.path,
        branch: worktree.branch,
        pty: spawned.pty,
        lead: true
      })
      this.pendingStarts.delete(pending.agentId)

      this.openWindow(record, LEAD_COLOR)

      const seedText = spawned.launch.ptySystemPrompt
        ? `${spawned.launch.ptySystemPrompt}\n\n${input.task}`
        : input.task
      const accepted = await this.seed(record, seedText, this.autoSubmitTasks)
      if (!accepted) {
        throw new Error(
          `${pending.name} (${provider.label}) never became ready — the CLI did not accept its area.`
        )
      }
      record.seeded = true
      record.assignmentCursor = this.queueFor(record.agentId).cursor
    } catch (error) {
      this.pendingStarts.delete(pending.agentId)
      this.discard(pending.agentId, pending.name, spawned?.pty)
      throw error
    }
  }

  /**
   * The heavy half of {@link beginAgent}: worktree, spawn, window, seed. Runs
   * behind the returned `ready` promise so `start_agent` never sits on it —
   * the pipeline (keyboard wait, settle, gated Enters) can outlast the 60 s
   * MCP request timeout. Every failure releases the reservation and discards
   * the half-started agent; a workspace that closed mid-start does the same.
   */
  private async finishStart(
    pending: PendingStart,
    slot: Slot,
    provider: ProviderConfig,
    template: RoleTemplate,
    input: StartAgentInput,
    urls: WorkspaceMcpUrls
  ): Promise<void> {
    let spawned: SpawnedAgent | undefined
    try {
      // Always isolated: every agent gets its own worktree and branch, so
      // parallel agents — and parallel workspaces on the same repository —
      // never trample each other's checkout. Merging stays an ordinary
      // git merge of vertragus/* branches, and `baseBranch` lets an agent
      // start on top of another agent's result instead of the repo HEAD.
      const worktree = await this.createWorktreeFor(pending.agentId, pending.name, input.baseBranch)
      this.assertOpenDuringStart(pending)

      const launchInput: AgentLaunchInput = {
        kind: 'subagent',
        provider,
        model: pending.model,
        effort: slot.effort,
        // Subagents default to yolo — a worker that cannot act is the old
        // repo's "permission-starved" failure. The orchestrator never gets it.
        // D4: only the `ask-user` tier drops the flags (the CLI's own prompt
        // asks in the terminal); `ask-orchestrator` keeps them and gates via
        // the contract instead — nobody sits at a subagent terminal.
        yolo: this.agentPolicy() !== 'ask-user',
        // E6: the slot's extra MCP servers — spawn honors them for subagents only.
        ...(slot.extraMcp ? { extraMcp: slot.extraMcp } : {}),
        cwd: worktree.path,
        mcpUrl: urls.subagentUrl(pending.agentId),
        fileTag: `sub-${pending.agentId}`,
        configDir: this.deps.configDir,
        systemPrompt: template.prompt
      }
      spawned = await (this.deps.spawn ?? spawnAgent)(launchInput)
      this.assertOpenDuringStart(pending)

      const record = this.track({
        agentId: pending.agentId,
        name: pending.name,
        roleId: pending.roleId,
        slotId: pending.slotId,
        providerId: provider.id,
        model: pending.model,
        worktreePath: worktree.path,
        branch: worktree.branch,
        pty: spawned.pty
      })
      // Tracked and un-reserved in the same synchronous step — the agent is
      // never counted twice and never invisible.
      this.pendingStarts.delete(pending.agentId)

      this.openWindow(record, this.colorFor(pending.roleId))

      // `input.task` already carries the reporting contract — appended by the
      // MCP layer, see the class comment. A provider without a system-prompt
      // flag gets its role prompt typed in front of the task instead.
      const seedText = spawned.launch.ptySystemPrompt
        ? `${spawned.launch.ptySystemPrompt}\n\n${input.task}`
        : input.task
      const accepted = await this.seed(record, seedText, this.autoSubmitTasks)
      if (!accepted) {
        throw new Error(
          `${pending.name} (${provider.label}) never became ready — the CLI did not accept its task.`
        )
      }
      record.seeded = true
      record.assignmentCursor = this.queueFor(record.agentId).cursor
    } catch (error) {
      // A half-started agent must not hold a name, a window, a process — or
      // its reservation.
      this.pendingStarts.delete(pending.agentId)
      this.discard(pending.agentId, pending.name, spawned?.pty)
      throw error
    }
  }

  /** A workspace that closed while an agent was starting aborts that start. */
  private assertOpenDuringStart(pending: PendingStart): void {
    if (this.closed) {
      throw new Error(`Workspace ${this.name} closed while ${pending.name} was starting.`)
    }
  }

  async sendToAgent(agentId: string, text: string): Promise<void> {
    const record = this.requireAgent(agentId)
    if (!record.pty.isAlive) {
      throw new Error(`${record.name} is no longer running — its process has ended.`)
    }
    if (!record.seeded && !record.orchestrator) {
      // The seed handshake is still typing into this PTY; a second concurrent
      // write would interleave with it. (Before async starts this state was
      // unreachable — the agent was not tracked until seeded.)
      throw new Error(
        `${record.name} is still starting — wait for its agent_started event.`
      )
    }
    const accepted = await this.seed(record, text, this.autoSubmitTasks)
    if (!accepted) throw new Error(`${record.name} did not accept the message.`)
    // A new assignment resets the "has it confirmed?" question — and the
    // sentinel dedup memory, so a legitimate identical DONE for a follow-up
    // still fires. Seed echoes were suppressed during the write; reset drops
    // any partial buffer state before the agent speaks again. F: the cursor
    // belongs to the queue this agent's events land in (its parent's).
    record.assignmentCursor = this.queueFor(agentId).cursor
    record.doneSinceAssignment = false
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

  async inspectAgent(agentId: string, options: InspectAgentOptions): Promise<InspectAgentResult> {
    const record = this.requireAgent(agentId)
    const result = await inspectWorktree(
      {
        worktreePath: record.worktreePath,
        view: options.view,
        path: options.path,
        lines: options.lines
      },
      this.deps.worktreeDeps
    )
    return {
      view: result.view,
      body: result.body,
      ...this.factsOf(result)
    }
  }

  async snapshotWorktree(agentId: string): Promise<WorktreeFacts> {
    const record = this.requireAgent(agentId)
    return this.factsOf(await snapshotWorktree(record.worktreePath, this.deps.worktreeDeps))
  }

  async snapshotDone(agentId: string, summary: string): Promise<WorktreeFacts> {
    const record = this.requireAgent(agentId)
    const deps = this.deps.worktreeDeps
    const before = await snapshotWorktree(record.worktreePath, deps)
    if (!before.uncommitted) return this.factsOf(before)
    try {
      await commitWorktree(
        record.worktreePath,
        snapshotCommitMessage(record.name, record.roleId, summary),
        deps
      )
      const after = await snapshotWorktree(record.worktreePath, deps)
      return {
        branch: after.branch,
        headSha: after.headSha,
        uncommitted: after.uncommitted,
        // The done's OWN change set — post-commit porcelain is empty, and an
        // agent_done that says "nothing changed" about committed work is a lie.
        changedFiles: before.changedFiles,
        diffStat: before.diffStat
      }
    } catch {
      // The dirty snapshot is still the truth; a failed commit must neither
      // drop the done event nor pretend the branch carries the work.
      return this.factsOf(before)
    }
  }

  private factsOf(snapshot: {
    branch: string
    headSha: string
    uncommitted: boolean
    changedFiles: string[]
    diffStat: string
  }): WorktreeFacts {
    return worktreeEventFields(snapshot)
  }

  async integrateBranch(agentId: string, branch: string): Promise<IntegrateOutcome> {
    const record = this.requireAgent(agentId)
    return mergeBranchIntoWorktree(record.worktreePath, branch, this.deps.worktreeDeps)
  }

  /**
   * E1 Promote — the USER's click, never an agent tool: merge one agent's
   * branch into the repository's own checkout (`repoPath`). Refuses a dirty
   * main checkout — promoting over uncommitted user work would be exactly the
   * "overwrite my repo" accident the remote allow-list also refuses to offer.
   * No push, no --force; a conflict aborts and reports.
   */
  async promoteAgentBranch(agentId: string): Promise<IntegrateOutcome> {
    const record = this.requireAgent(agentId)
    const deps = this.deps.worktreeDeps
    const main = await snapshotWorktree(this.repoPath, deps)
    if (main.uncommitted) {
      throw new Error(
        'Promote refused — the main checkout has uncommitted changes. Commit or stash them first.'
      )
    }
    return mergeBranchIntoWorktree(this.repoPath, record.branch, deps)
  }

  /**
   * E4: the wall clock over agent-seconds — subagents and leads count, the
   * orchestrator (the reader) does not. Reservations are ignored: seconds are
   * only honest once a process exists.
   */
  budget(): WorkspaceBudget {
    const now = this.now()
    let usedMs = 0
    for (const record of this.agents.values()) {
      if (record.orchestrator) continue
      usedMs += Math.max(0, (record.endedAt ?? now) - record.startedAt)
    }
    const usedSec = Math.round(usedMs / 1_000)
    const limitSec =
      this.profile.maxRuntimeMin !== undefined ? this.profile.maxRuntimeMin * 60 : undefined
    return {
      usedSec,
      ...(limitSec !== undefined ? { limitSec } : {}),
      exhausted: limitSec !== undefined && usedSec >= limitSec
    }
  }

  /**
   * The worktrees of every agent whose process is still alive — orchestrator
   * included. This is what the panel's cleanup view must NOT offer for
   * removal; everything else under the worktree root is fair game.
   */
  activeWorktreePaths(): string[] {
    return [
      ...[...this.agents.values()]
        .filter((record) => record.pty.isAlive && !record.stopped)
        .map((record) => record.worktreePath),
      // Mid-creation worktrees of reserved starts must not look stale — the
      // cleanup view offering a directory `git worktree add` is busy writing
      // is a race nobody wins.
      ...[...this.pendingStarts.values()]
        .filter((pending) => !this.agents.has(pending.agentId))
        .map((pending) => pending.worktreePath)
    ]
  }

  /**
   * Re-open the CLI window of a still-listed agent — finished ones included.
   *
   * Closing a window is a view decision, not a process decision: the PTY and
   * the record stay, so the user can come back to the scrollback of a worker
   * that already reported done. Unknown or discarded agents return false.
   */
  showAgentWindow(agentId: string): boolean {
    const record = this.agents.get(agentId)
    if (!record) return false
    this.openWindow(
      record,
      record.orchestrator ? ORCHESTRATOR_COLOR : record.lead ? LEAD_COLOR : this.colorFor(record.roleId)
    )
    return true
  }

  /**
   * Every subagent, in start order. The orchestrator is deliberately absent: it
   * is the reader of this list, and counting it would eat one of its own slots.
   */
  listAgents(): AgentSummary[] {
    const now = this.now()
    return [
      ...[...this.agents.values()]
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
          ...(record.lead ? { kind: 'lead' as const } : {}),
          reporting: this.reportingForProvider(record.providerId)
        })),
      // Reservations: begun but not yet spawned. They occupy their slot (the
      // `start_agent` limit check counts this list), and the orchestrator sees
      // them as `starting` instead of wondering where its agent went.
      ...[...this.pendingStarts.values()]
        .filter((pending) => !this.agents.has(pending.agentId))
        .map((pending) => ({
          agentId: pending.agentId,
          name: pending.name,
          role: pending.roleId,
          status: AGENT_STATUS.starting,
          model: pending.model,
          worktreePath: pending.worktreePath,
          branch: pending.branch,
          lastOutputAgeSec: 0,
          ...(pending.lead ? { kind: 'lead' as const } : {}),
          reporting: this.reportingForProvider(pending.providerId)
        }))
    ]
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
      knowledge: this.deps.retro?.knowledge(this.profile) ?? [],
      // E2: best-effort — a repo without docs or git history still boots.
      briefing: await this.collectBriefing()
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
      // C5: the idle clock starts at boot — an orchestrator that never makes
      // its first tool call is exactly as idle as one that stopped mid-run.
      this.noteOrchestratorActivity()
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
   * D2: the human steers the run. The text becomes VISIBLE in the
   * orchestrator's terminal (display-only — typing it in would start a second
   * turn beside the MCP loop, the exact two-brains failure H1 documents) and
   * lands as a `user_message` event in the queue, which is what wakes a
   * parked `await_events` immediately.
   */
  postUserMessage(text: string): void {
    this.assertOpen()
    const record = this.orchestratorRecord
    if (!record || !this.orchestratorAlive) {
      throw new Error(`Workspace ${this.name} has no running orchestrator to steer.`)
    }
    if (this.events.isClosed) throw new Error(`Workspace ${this.name} is closed.`)
    record.pty.push(`\r\n\x1b[36mUser (via Vertragus): ${text}\x1b[0m\r\n`)
    this.events.push({ type: 'user_message', text })
  }

  /**
   * Seed the user's goal into the orchestrator's CLI — the SAME handshake every
   * assignment takes (H2), so "start with a goal" and "type the goal into the
   * TUI" are one mechanism, not two. Always submitted: the goal comes straight
   * from the user, there is nothing left to redact. Throws when the CLI did not
   * accept the text; the workspace keeps running then (the user can still type
   * into the terminal), and {@link goalText} stays unset — an undelivered goal
   * must not show up on the card as if the orchestrator had it.
   */
  async assignGoal(goal: string): Promise<void> {
    this.assertOpen()
    const record = this.orchestratorRecord
    if (!record) throw new Error(`Workspace ${this.name} has no orchestrator to give a goal to.`)
    if (!record.pty.isAlive) {
      throw new Error(`${record.name} is no longer running — its process has ended.`)
    }
    const accepted = await this.seed(record, goal, true)
    if (!accepted) {
      throw new Error(`${record.name} did not accept the goal — type it into its terminal instead.`)
    }
    this.goal = goal
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

  /**
   * E2: the capped repository briefing — the first project doc that exists
   * (AGENTS.md / CLAUDE.md / README.md), the last eight commits, and the
   * stored repo notes. Every part is best-effort and hard-capped; no RAG,
   * no index — just what a human would skim before the first delegation.
   */
  private async collectBriefing(): Promise<string | undefined> {
    const cap = (text: string, max: number): string =>
      text.length <= max ? text : `${text.slice(0, max)}\n…(truncated)`
    const parts: string[] = []
    // E3 first: what this run continues matters more than what the repo is.
    if (this.deps.resumeBriefing?.trim()) {
      parts.push(`--- resumed run ---\n${cap(this.deps.resumeBriefing.trim(), 2_500)}`)
    }
    for (const file of ['AGENTS.md', 'CLAUDE.md', 'README.md']) {
      try {
        const text = await readFile(join(this.repoPath, file), 'utf8')
        if (text.trim()) {
          parts.push(`--- ${file} (capped) ---\n${cap(text.trim(), 1_500)}`)
          break
        }
      } catch {
        /* try the next doc */
      }
    }
    try {
      const git = this.deps.worktreeDeps?.git ?? defaultGitRunner
      const { stdout } = await git(['log', '-8', '--oneline'], this.repoPath)
      if (stdout.trim()) parts.push(`--- last commits ---\n${cap(stdout.trim(), 800)}`)
    } catch {
      /* an empty or brand-new repo has no log */
    }
    const notes = this.deps.retro?.repoNotes?.(this.profile) ?? []
    if (notes.length > 0) {
      parts.push(
        `--- repo notes from previous runs ---\n${notes
          .slice(0, 20)
          .map((note) => `- ${note}`)
          .join('\n')}`
      )
    }
    return parts.length > 0 ? parts.join('\n\n') : undefined
  }

  /** Roles and their caps, as the orchestrator prompt renders them. */
  rolesWithLimits(): RoleWithLimit[] {
    const templates = allRoleTemplates(this.deps.roleTemplates ?? [])
    return profileRoleIds(this.profile).map((roleId) => ({
      id: roleId,
      description: templates.find((template) => template.id === roleId)?.name,
      max: slotLimitFor(this.profile, roleId).max,
      // Track 4: what start_agent{providerId}/{slotId} can address.
      slots: this.profile.slots
        .filter((slot) => slot.roleId === roleId)
        .map((slot) => ({
          id: slot.id,
          providerId: slot.providerId,
          ...(slot.model ? { model: slot.model } : {})
        }))
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
   *
   * `awaitExitMs` waits for the killed processes to actually die (bounded).
   * The quit path needs this: `pty.kill()` is fire-and-forget (Windows
   * `taskkill`, POSIX SIGTERM→SIGKILL escalation), and an app that exits
   * before the kills land leaves yolo-mode CLIs orphaned on the machine.
   */
  async close(options: { awaitExitMs?: number } = {}): Promise<void> {
    if (this.closed) return
    this.closed = true
    // Capture before stopAll — it is the records that know the PTYs, and
    // `agents.clear()` below forgets them.
    const live = [...this.agents.values()].filter((record) => record.pty.isAlive)
    await this.stopAll()
    if (options.awaitExitMs !== undefined && options.awaitExitMs > 0) {
      await Promise.all(live.map((record) => awaitPtyExit(record.pty, options.awaitExitMs!)))
    }
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

  /**
   * The first slot of the role with free capacity — NOT simply the first slot
   * of the role. `slotLimitFor` sums `maxCount` across all slots of a role, so
   * a role can be under its cap while its first slot is full; the agent then
   * belongs on the next slot, which is the whole point of configuring two
   * slots for one role (a different provider or model for the overflow).
   * Reservations count exactly like live records.
   *
   * Track 4: an explicit `slotId` or `providerId` narrows the candidates
   * FIRST — an explicit choice that is unknown or full is a hard error, never
   * a silent fallback to another slot. Without it, "first with room" still
   * wins (back-compat), which in practice favours the first provider.
   */
  private slotWithCapacity(
    roleId: string,
    choice: { slotId?: string; providerId?: string } = {}
  ): Slot {
    const slots = this.profile.slots.filter((candidate) => candidate.roleId === roleId)
    if (slots.length === 0) {
      throw new Error(
        `No slot configured for role "${roleId}" in profile "${this.profile.name}".`
      )
    }

    const hasRoom = (slot: Slot): boolean =>
      slot.maxCount === undefined || this.countForSlot(slot.id) < slot.maxCount

    if (choice.slotId) {
      const slot = slots.find((candidate) => candidate.id === choice.slotId)
      if (!slot) {
        throw new Error(
          `Unknown slotId "${choice.slotId}" for role "${roleId}" — configured slots: ${slots
            .map((candidate) => candidate.id)
            .join(', ')}.`
        )
      }
      if (choice.providerId && slot.providerId !== choice.providerId) {
        throw new Error(
          `Slot "${slot.id}" runs provider "${slot.providerId}", not "${choice.providerId}" — drop one of the two parameters.`
        )
      }
      if (!hasRoom(slot)) {
        throw new Error(`Slot "${slot.id}" of role "${roleId}" is at its limit.`)
      }
      return slot
    }

    if (choice.providerId) {
      const matching = slots.filter((candidate) => candidate.providerId === choice.providerId)
      if (matching.length === 0) {
        throw new Error(
          `No slot of role "${roleId}" runs provider "${choice.providerId}" — configured providers: ${[
            ...new Set(slots.map((candidate) => candidate.providerId))
          ].join(', ')}.`
        )
      }
      for (const slot of matching) if (hasRoom(slot)) return slot
      throw new Error(
        `Every "${choice.providerId}" slot of role "${roleId}" is at its limit.`
      )
    }

    for (const slot of slots) {
      if (hasRoom(slot)) return slot
    }
    throw new Error(
      `Every slot of role "${roleId}" in profile "${this.profile.name}" is at its limit.`
    )
  }

  /** Agents (live or reserved) currently occupying one profile slot. */
  private countForSlot(slotId: string): number {
    let count = 0
    for (const pending of this.pendingStarts.values()) {
      if (pending.slotId === slotId) count += 1
    }
    for (const record of this.agents.values()) {
      if (record.orchestrator || record.slotId !== slotId) continue
      const status = this.statusOf(record)
      if (status !== AGENT_STATUS.exited && status !== AGENT_STATUS.stopped) count += 1
    }
    return count
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
    if (!record) {
      const pending = this.pendingStarts.get(agentId)
      if (pending) {
        throw new Error(
          `${pending.name} is still starting — wait for its agent_started event.`
        )
      }
      throw new Error(`Unknown agent ${agentId}.`)
    }
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
    slotId?: string
    providerId: string
    model?: string
    worktreePath: string
    branch: string
    pty: AgentPty
    orchestrator?: boolean
    lead?: boolean
  }): AgentRecord {
    const record: AgentRecord = {
      agentId: input.agentId,
      name: input.name,
      roleId: input.roleId,
      slotId: input.slotId,
      providerId: input.providerId,
      model: input.model,
      worktreePath: input.worktreePath,
      branch: input.branch,
      pty: input.pty,
      orchestrator: input.orchestrator === true,
      lead: input.lead === true,
      seeded: false,
      stopping: false,
      stopped: false,
      lastOutputAt: this.now(),
      startedAt: this.now(),
      assignmentCursor: this.events.cursor,
      doneSinceAssignment: false,
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
      roleColor: input.orchestrator
        ? ORCHESTRATOR_COLOR
        : input.lead
          ? LEAD_COLOR
          : this.colorFor(record.roleId),
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
    const queue = this.queueFor(record.agentId)
    if (queue.isClosed || record.orchestrator) return
    const identity = {
      agentId: record.agentId,
      name: record.name,
      roleId: record.roleId
    }
    switch (report.kind) {
      case 'done':
        record.doneSinceAssignment = true
        void this.emitAgentDone(record, report.summary, report.status)
        return
      case 'progress':
        queue.push({ type: 'agent_progress', ...identity, note: report.note })
        return
      case 'unparseable':
        queue.push({
          type: 'agent_progress',
          ...identity,
          note: `unparseable sentinel line (${report.reason})`
        })
        return
      case 'ask': {
        if (!this.questions) {
          // Wiring bug: WorkspaceManager always attachQuestions. Surface it.
          queue.push({
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
        queue.push({
          type: 'agent_question',
          ...identity,
          questionId: pending.questionId,
          question: report.question
        })
        return
      }
    }
  }

  /**
   * Push `agent_done` with host-truth git facts when git answers. Since C3
   * the snapshot also COMMITS a dirty worktree onto the agent's branch (see
   * {@link snapshotDone}). A git failure still emits the prose-only event —
   * never drop a done report.
   */
  private async emitAgentDone(
    record: AgentRecord,
    summary: string,
    status: AgentDoneStatus
  ): Promise<void> {
    const payload = {
      type: 'agent_done' as const,
      agentId: record.agentId,
      name: record.name,
      roleId: record.roleId,
      summary,
      status
    }
    const queue = this.queueFor(record.agentId)
    try {
      const facts = await this.snapshotDone(record.agentId, summary)
      if (queue.isClosed) return
      queue.push({ ...payload, ...facts })
    } catch {
      if (queue.isClosed) return
      queue.push(payload)
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
    if (record.idleNotified || this.queueFor(record.agentId).isClosed) return
    const status = this.statusOf(record)
    if (status === AGENT_STATUS.exited || status === AGENT_STATUS.stopped) return
    // A fake clock (or a timer that fired early) must not produce a false hint.
    if (this.now() - record.lastOutputAt < PTY_ONLY_IDLE_HINT_MS) {
      this.armIdleHint(record)
      return
    }
    record.idleNotified = true
    this.queueFor(record.agentId).push({
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
   *
   * An Enter the handshake could not confirm does NOT fail the seed — the text
   * reached a live CLI and may well be running. It is written into the agent's
   * own scrollback instead, so the one place someone debugging a silent agent
   * looks says "press Enter" rather than nothing at all. Previously this case
   * was indistinguishable from a clean delivery.
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
      {
        ...seedOptionsFromProvider(provider?.seed),
        ...this.deps.seedOptions,
        autoSubmit,
        onSubmitted: (confirmed) => {
          if (confirmed) return
          record.pty.push(
            `\r\n\x1b[33mVertragus: ${record.name} never reacted to the submitting Enter — ` +
              `the text is in the composer, press Enter here if it is still sitting there.\x1b[0m\r\n`
          )
        }
      }
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
    record.endedAt = record.endedAt ?? this.now()
    // A dead process is not a silent one — its exit event says everything.
    this.clearIdleHint(record)
    if (record.orchestrator) {
      this.clearOrchestratorIdleWatchdog()
      // Its open ask_user is unanswerable now — the badge must go dark.
      this.questions?.cancelForAgent(USER_QUESTION_AGENT_ID)
    }
    this.questions?.cancelForAgent(record.agentId)
    if (record.stopping) return
    if (this.events.isClosed) return
    if (record.orchestrator) {
      // The record stays: the window keeps showing the death output and
      // stopWorkspace still closes it. Only `orchestratorAlive` flips, which
      // is what greys the panel card out. The event is for the history (and
      // any non-orchestrator reader, e.g. a remote client) — the orchestrator
      // itself is the one reader that can no longer see it.
      this.events.push({
        type: 'orchestrator_exited',
        agentId: record.agentId,
        name: record.name,
        roleId: record.roleId,
        exitCode: info.exitCode ?? null
      })
      return
    }
    // F: a grandchild's death goes to its lead; a lead's own death goes to
    // the root, where the adoption tap reparents its children.
    this.queueFor(record.agentId).push({
      type: 'agent_exited',
      agentId: record.agentId,
      name: record.name,
      roleId: record.roleId,
      exitCode: info.exitCode ?? null,
      confirmed: this.hasConfirmedSinceAssignment(record)
    })
  }

  private hasConfirmedSinceAssignment(record: AgentRecord): boolean {
    if (record.doneSinceAssignment) return true
    return this.queueFor(record.agentId)
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
    record.endedAt = record.endedAt ?? this.now()
    this.clearIdleHint(record)
    if (record.orchestrator) {
      this.clearOrchestratorIdleWatchdog()
      this.questions?.cancelForAgent(USER_QUESTION_AGENT_ID)
    }
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
