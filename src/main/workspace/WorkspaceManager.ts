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
import { workspacePlaceName } from '@shared/workspaceNames'
import type { Profile } from '@shared/schema/profile'
import type { StartedAgent } from '@main/mcp/types'
import { Workspace, type WorkspaceDeps, type WorkspaceMcpUrls } from './Workspace'

export interface WorkspaceManagerDeps
  extends Omit<WorkspaceDeps, 'providers' | 'roleTemplates' | 'yoloMaster'> {
  mcp: McpServerHandle
  /** Read fresh per start so a provider edit reaches the next workspace. */
  providers: WorkspaceDeps['providers'] | (() => WorkspaceDeps['providers'])
  roleTemplates?: WorkspaceDeps['roleTemplates'] | (() => WorkspaceDeps['roleTemplates'])
  /** Master yolo switch; also read fresh per start. */
  yoloMaster?: boolean | (() => boolean)
}

export interface RunningWorkspace {
  workspace: Workspace
  orchestrator: StartedAgent
  urls: WorkspaceMcpUrls
}

export interface WorkspaceManager {
  startWorkspace(profile: Profile): Promise<RunningWorkspace>
  stopWorkspace(workspaceId: string): Promise<boolean>
  stopAll(): Promise<void>
  get(workspaceId: string): Workspace | undefined
  list(): Workspace[]
  /** Workspaces of one profile, for the panel's per-profile grouping. */
  listForProfile(profileId: string): Workspace[]
}

function resolveValue<T>(source: T | (() => T)): T {
  return typeof source === 'function' ? (source as () => T)() : source
}

export function createWorkspaceManager(deps: WorkspaceManagerDeps): WorkspaceManager {
  const workspaces = new Map<string, Workspace>()
  /** Per-profile Commedia sequence. In memory by design — see the file comment. */
  const sequences = new Map<string, number>()

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
      yoloMaster: deps.yoloMaster === undefined ? true : resolveValue(deps.yoloMaster)
    }
  }

  async function startWorkspace(profile: Profile): Promise<RunningWorkspace> {
    if (!profile.repoPath.trim()) {
      throw new Error(`Profile "${profile.name}" has no repository path.`)
    }
    const workspace = new Workspace({ profile, name: nextName(profile.id) }, workspaceDeps())

    // Register before spawning: the orchestrator's launch args contain its MCP
    // URL, so there is no window in which an agent exists without an attachment.
    // Hand URLs and the PendingQuestions registry to the workspace — sentinel
    // ASK lines create entries in the same registry MCP tools use.
    const registered = deps.mcp.registerWorkspace(workspace.mcpContext())
    workspace.attachMcp(registered)
    workspace.attachQuestions(registered.runtime.questions)
    workspaces.set(workspace.workspaceId, workspace)

    try {
      const orchestrator = await workspace.startOrchestrator()
      return { workspace, orchestrator, urls: registered }
    } catch (error) {
      workspaces.delete(workspace.workspaceId)
      await workspace.close()
      deps.mcp.unregisterWorkspace(workspace.workspaceId)
      throw error
    }
  }

  async function stopWorkspace(workspaceId: string): Promise<boolean> {
    const workspace = workspaces.get(workspaceId)
    if (!workspace) return false
    workspaces.delete(workspaceId)
    // Agents first (subagents, then the orchestrator), then the registration —
    // unregisterWorkspace closes the EventQueue, and a push after that throws.
    await workspace.close()
    deps.mcp.unregisterWorkspace(workspaceId)
    return true
  }

  return {
    startWorkspace,
    stopWorkspace,

    async stopAll(): Promise<void> {
      for (const workspaceId of [...workspaces.keys()]) await stopWorkspace(workspaceId)
    },

    get: (workspaceId) => workspaces.get(workspaceId),
    list: () => [...workspaces.values()],
    listForProfile: (profileId) =>
      [...workspaces.values()].filter((workspace) => workspace.profileId === profileId)
  }
}
