/**
 * The app-level registry of running workspaces — what the Play button drives.
 *
 * `startWorkspace(profile)` is the whole spawn pipeline in one call:
 *
 *   name → Workspace (tokens, EventQueue, NameAllocator)
 *        → mcp.registerWorkspace (URLs)
 *        → orchestrator PTY + CLI window
 *
 * and `stopWorkspace` is its exact inverse, in the order that matters: every
 * subagent first, the orchestrator last (so it does not watch its team die and
 * start replacing them), then the MCP registration — which is what closes the
 * EventQueue and releases the parked `await_events` readers.
 *
 * Naming: workspaces of one profile walk the Commedia place list in order
 * ("Paradiso", "Purgatorio", …, then "Paradiso II"). The counter is per profile
 * and lives in memory only — this wave deliberately does not persist it. A
 * restart may hand out "Paradiso" again; that costs nothing, and a persisted
 * counter that only ever grows is a worse artefact than a repeated name.
 *
 * Electron is only present through injected dependencies (an {@link AgentRegistry}
 * and a {@link WorkspaceWindows} adapter), so the whole manager is testable
 * against fakes with no Electron runtime in sight.
 */
import type { McpServerHandle } from '@main/mcp/server'
import { queueForAgent } from '@main/mcp/types'
import { workspacePlaceName } from '@shared/workspaceNames'
import type { Profile } from '@shared/schema/profile'
import type { StartedAgent } from '@main/mcp/types'
import type { AgentEvent } from '@shared/schema/events'
import type { OrchestratorHandoffPackage } from '@shared/schema/handoff'
import type { TaskBoardState } from '@shared/schema/tasks'
import type { RetroSink } from './retroSink'
import type { RunJournal } from './journal'
import type { TaskBoard } from './taskBoard'
import { Workspace, type WorkspaceDeps, type WorkspaceMcpUrls } from './Workspace'

export interface WorkspaceManagerDeps
  extends Omit<
    WorkspaceDeps,
    | 'providers'
    | 'roleTemplates'
    | 'yoloMaster'
    | 'agentPolicy'
    | 'retro'
    | 'resumeBriefing'
    | 'resumeSuccession'
  > {
  mcp: McpServerHandle
  /** Read fresh per start so a provider edit reaches the next workspace. */
  providers: WorkspaceDeps['providers'] | (() => WorkspaceDeps['providers'])
  roleTemplates?: WorkspaceDeps['roleTemplates'] | (() => WorkspaceDeps['roleTemplates'])
  /** Master yolo switch; also read fresh per start. */
  yoloMaster?: boolean | (() => boolean)
  /** D4: the three-tier policy; wins over `yoloMaster`. Also read fresh per start. */
  agentPolicy?: WorkspaceDeps['agentPolicy'] | (() => WorkspaceDeps['agentPolicy'])
  /** Full sink (the workspace itself only sees the feed slice). Absent = no retro. */
  retro?: RetroSink
  /**
   * E3: run-journal factory. Absent = no journal (unit tests). Production
   * passes {@link createRunJournal} so every event of a run — subtree events
   * included — survives the EventQueue's ring in
   * `.vertragus/runs/<id>/events.jsonl`.
   */
  journal?: (repoPath: string, workspaceId: string) => RunJournal
  /**
   * S4: task-board factory, created next to the journal. Absent = no board
   * (unit tests) — the task tools then answer `task_board_unavailable`.
   * Production passes {@link createTaskBoard}, which persists the board to
   * `.vertragus/runs/<id>/tasks.json`.
   */
  taskBoard?: (repoPath: string, workspaceId: string) => TaskBoard
}

export interface RunningWorkspace {
  workspace: Workspace
  orchestrator: StartedAgent
  urls: WorkspaceMcpUrls
}

/** Options for the stop paths; `awaitExitMs` bounds the wait for real process death. */
export interface StopOptions {
  /**
   * Wait up to this long for the killed CLI processes to actually exit. The
   * quit path sets it — exiting the app before the kills land orphans
   * yolo-mode CLIs. Absent = fire the kills and return (interactive stop).
   */
  awaitExitMs?: number
}

/** Options for {@link WorkspaceManager.startWorkspace}. */
export interface StartWorkspaceOptions {
  /**
   * Goal for the orchestrator's first user turn (H2). Providers that declare
   * `initialPromptDelivery` receive it at spawn; others are PTY-seeded after
   * boot via the assignment handshake. Absent = the classic bare Play: allowed,
   * the card shows "no goal" until someone types one into the TUI.
   */
  goal?: string
  /**
   * E3: this start resumes an earlier run. The briefing (built by
   * `resume.buildResumeBriefing` from the old run's journal) lands in the new
   * orchestrator's system prompt; `fromWorkspaceId` is recorded in the new
   * run's meta. Nothing else is restored — the old processes are gone.
   */
  resume?: {
    briefing: string
    fromWorkspaceId: string
    /**
     * S4: the resumed run's task board, already transformed for the new run
     * (dead owners freed — see `resume.boardForResume`). Seeds the new board.
     */
    tasks?: TaskBoardState
    /**
     * C6: the frozen succession package of that run — present only when it
     * died mid-handoff (see `resume.readSuccessionPackage`). It REPLACES the
     * briefing in the orchestrator prompt: same dead run, more of it, and two
     * accounts of one run would only compete for the successor's attention.
     */
    succession?: OrchestratorHandoffPackage
  }
}

export interface WorkspaceManager {
  startWorkspace(profile: Profile, options?: StartWorkspaceOptions): Promise<RunningWorkspace>
  stopWorkspace(workspaceId: string, options?: StopOptions): Promise<boolean>
  stopAll(options?: StopOptions): Promise<void>
  get(workspaceId: string): Workspace | undefined
  list(): Workspace[]
  /** Workspaces of one profile, for the panel's per-profile grouping. */
  listForProfile(profileId: string): Workspace[]
  /**
   * Fires after anything that changes what {@link list} would render: a
   * workspace starting or stopping, any agent event (start, done, question,
   * exit — orchestrator death included), and question-registry mutations
   * (answered badges going dark). Bursts within one tick collapse into a
   * single notification. This is what lets the panel stop polling.
   */
  onChange(listener: () => void): () => void
  /**
   * Feed a user-input chunk from an agent's CLI. Only the workspace whose
   * orchestrator owns `agentId` is considered; a subagent is a no-op. First
   * successful note sticks on {@link Workspace.goalText}; a start-with-goal
   * is never overwritten. Fires {@link onChange} when the goal newly lands.
   */
  noteOrchestratorGoal(agentId: string, chunk: string): boolean
}

function resolveValue<T>(source: T | (() => T)): T {
  return typeof source === 'function' ? (source as () => T)() : source
}

export function createWorkspaceManager(deps: WorkspaceManagerDeps): WorkspaceManager {
  const workspaces = new Map<string, Workspace>()
  /** Per-profile Commedia sequence. In memory by design — see the file comment. */
  const sequences = new Map<string, number>()
  /**
   * Full event history per workspace, tapped at push time. The EventQueue's
   * ring only holds the last 1000 events — a long run's early agent_started
   * events would be gone by stop time, and stats without identity are noise.
   */
  const eventTaps = new Map<string, { events: AgentEvent[]; off: () => void }>()
  /** Per-workspace change subscriptions (event queue + question registry). */
  const changeTaps = new Map<string, Array<() => void>>()
  const changeListeners = new Set<() => void>()
  let notifyScheduled = false

  /** Collapse same-tick bursts into one notification — no timers involved. */
  function notifyChange(): void {
    if (notifyScheduled || changeListeners.size === 0) return
    notifyScheduled = true
    queueMicrotask(() => {
      notifyScheduled = false
      for (const listener of [...changeListeners]) listener()
    })
  }

  function dropChangeTap(workspaceId: string): void {
    for (const off of changeTaps.get(workspaceId) ?? []) off()
    changeTaps.delete(workspaceId)
  }

  function nextName(profileId: string): string {
    const sequence = (sequences.get(profileId) ?? 0) + 1
    sequences.set(profileId, sequence)
    return workspacePlaceName(sequence)
  }

  function workspaceDeps(): WorkspaceDeps {
    return {
      ...deps,
      providers: resolveValue(deps.providers),
      roleTemplates: deps.roleTemplates ? resolveValue(deps.roleTemplates) : [],
      yoloMaster: deps.yoloMaster === undefined ? true : resolveValue(deps.yoloMaster),
      agentPolicy: deps.agentPolicy === undefined ? undefined : resolveValue(deps.agentPolicy),
      retro: deps.retro
    }
  }

  function dropTap(workspaceId: string): { events: AgentEvent[] } | undefined {
    const tap = eventTaps.get(workspaceId)
    if (!tap) return undefined
    eventTaps.delete(workspaceId)
    tap.off()
    return tap
  }

  async function startWorkspace(
    profile: Profile,
    options?: StartWorkspaceOptions
  ): Promise<RunningWorkspace> {
    if (!profile.repoPath.trim()) {
      throw new Error(`Profile "${profile.name}" has no repository path.`)
    }
    const workspace = new Workspace(
      { profile, name: nextName(profile.id) },
      {
        ...workspaceDeps(),
        // E3: the previous run's briefing rides into the orchestrator prompt —
        // unless C6 left a succession package, which says the same and more
        // (see StartWorkspaceOptions.resume.succession).
        ...(options?.resume?.succession
          ? { resumeSuccession: options.resume.succession }
          : options?.resume
            ? { resumeBriefing: options.resume.briefing }
            : {})
      }
    )

    // Register before spawning: the orchestrator's launch args contain its MCP
    // URL, so there is no window in which an agent exists without an attachment.
    // Hand URLs and the PendingQuestions registry to the workspace — sentinel
    // ASK lines create entries in the same registry MCP tools use.
    const registered = deps.mcp.registerWorkspace(workspace.mcpContext())
    workspace.attachMcp(registered)
    workspace.attachQuestions(registered.runtime.questions)
    // F: host events about a lead's child go to the lead's queue, not the root's.
    workspace.attachEventRouter((agentId) => queueForAgent(registered.runtime, agentId))
    workspaces.set(workspace.workspaceId, workspace)
    // E3: the durable journal outlives the ring buffer. Never a blocker.
    const journal = ((): RunJournal | undefined => {
      try {
        return deps.journal?.(profile.repoPath, workspace.workspaceId)
      } catch (error) {
        console.warn('[journal] not started:', error)
        return undefined
      }
    })()
    // S4: the task board, next to the journal and equally never a blocker.
    // ONE assignment installs it for both readers — the tool layer calls
    // through `runtime.taskBoard`, the succession package reads the host's,
    // and the runtime property is an accessor over exactly that (see
    // `mcp/server.registerWorkspace`). Wiring one side and forgetting the
    // other is no longer expressible.
    try {
      const board = deps.taskBoard?.(profile.repoPath, workspace.workspaceId)
      if (board) {
        // Resume carries the old run's plan over — dead owners were already
        // freed by the caller (resume.boardForResume).
        if (options?.resume?.tasks) board.seed(options.resume.tasks)
        registered.runtime.taskBoard = board
      }
    } catch (error) {
      console.warn('[taskBoard] not started:', error)
    }
    // E3: the run's identity, once — everything after this line is events.
    journal?.writeMeta({
      workspaceId: workspace.workspaceId,
      profileId: profile.id,
      workspaceName: workspace.name,
      ...(options?.goal?.trim() ? { goal: options.goal.trim() } : {}),
      startedAt: Date.now(),
      ...(options?.resume ? { resumedFrom: options.resume.fromWorkspaceId } : {})
    })
    if (deps.retro) {
      const events: AgentEvent[] = []
      const off = workspace.events.onPush((event) => events.push(event))
      eventTaps.set(workspace.workspaceId, { events, off })
    }
    changeTaps.set(workspace.workspaceId, [
      workspace.events.onPush(() => notifyChange()),
      registered.runtime.questions.onMutate(() => notifyChange()),
      ...(journal ? [workspace.events.onPush((event) => journal.append(event))] : [])
    ])
    // F: lead queues carry the subtrees' events past the root queue — the
    // retro and the journal need them for honest history, the panel needs
    // the change ticks.
    registered.runtime.onLeadCreated = (lead) => {
      const tap = eventTaps.get(workspace.workspaceId)
      changeTaps
        .get(workspace.workspaceId)
        ?.push(
          lead.events.onPush((event) => {
            tap?.events.push(event)
            journal?.append(event)
            notifyChange()
          })
        )
    }
    // Assignments too: a follow-up task pushes no agent event, so without this
    // the panel's status lines and the CLI hover cards would lag behind it.
    registered.runtime.onTasksChanged = () => notifyChange()
    // C5: every orchestrator tool call feeds the host's idle watchdog.
    registered.runtime.onOrchestratorToolCall = () => workspace.noteOrchestratorActivity()
    // Visible right away — the card renders "starting" while the orchestrator
    // boots instead of appearing only once it is done.
    notifyChange()

    try {
      const goal = options?.goal?.trim()
      const orchestrator = await workspace.startOrchestrator(
        goal ? { initialPrompt: goal } : undefined
      )
      notifyChange()
      // Providers that take a first user prompt at spawn already have the goal
      // (goalText is set) — do not type a second copy into the TUI. Everyone
      // else still uses the assignment handshake. A failed PTY delivery does
      // NOT tear the workspace down: the orchestrator is running and the user
      // can still type into its terminal; the error travels to the caller
      // (panel banner / gateway error) and the card truthfully shows "no goal".
      if (goal && !workspace.goalText) {
        await workspace.assignGoal(goal)
        notifyChange()
      }
      return { workspace, orchestrator, urls: registered }
    } catch (error) {
      // Only a failed ORCHESTRATOR start unwinds the workspace; a delivered
      // orchestrator with an undelivered goal stays up (see above).
      if (workspace.orchestratorAlive) throw error
      workspaces.delete(workspace.workspaceId)
      dropTap(workspace.workspaceId)
      dropChangeTap(workspace.workspaceId)
      await workspace.close()
      deps.mcp.unregisterWorkspace(workspace.workspaceId)
      notifyChange()
      throw error
    }
  }

  async function stopWorkspace(workspaceId: string, options?: StopOptions): Promise<boolean> {
    const workspace = workspaces.get(workspaceId)
    if (!workspace) return false
    workspaces.delete(workspaceId)
    // Agents first (subagents, then the orchestrator), then the registration —
    // unregisterWorkspace closes the EventQueue, and a push after that throws.
    await workspace.close(options)
    const tap = dropTap(workspaceId)
    if (tap) {
      // A retro write failure must never block stopping the workspace.
      try {
        deps.retro?.finalizeRun({
          workspaceId,
          workspaceName: workspace.name,
          profileId: workspace.profileId,
          events: tap.events,
          summary: workspace.pendingRetroSummary
        })
      } catch (error) {
        console.warn('[retro] failed to record run retro:', error)
      }
    }
    dropChangeTap(workspaceId)
    deps.mcp.unregisterWorkspace(workspaceId)
    notifyChange()
    return true
  }

  return {
    startWorkspace,
    stopWorkspace,

    async stopAll(options?: StopOptions): Promise<void> {
      for (const workspaceId of [...workspaces.keys()]) await stopWorkspace(workspaceId, options)
    },

    get: (workspaceId) => workspaces.get(workspaceId),
    list: () => [...workspaces.values()],
    listForProfile: (profileId) =>
      [...workspaces.values()].filter((workspace) => workspace.profileId === profileId),

    onChange(listener: () => void): () => void {
      changeListeners.add(listener)
      return () => {
        changeListeners.delete(listener)
      }
    },

    noteOrchestratorGoal(agentId: string, chunk: string): boolean {
      const workspace = [...workspaces.values()].find((ws) => ws.orchestrator?.agentId === agentId)
      if (!workspace) return false
      if (!workspace.noteOrchestratorGoal(chunk)) return false
      notifyChange()
      return true
    }
  }
}
