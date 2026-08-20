/**
 * The dev entry from the plan: **the first real orchestrator run without any
 * UI**.
 *
 *   VERTRAGUS_DEV_RUN=C:\path\to\repo pnpm dev
 *
 * builds a synthetic profile (Claude orchestrator, a worker and a reviewer
 * slot, at most four subagents), starts the MCP server, and runs the complete
 * spawn pipeline — workspace, tokens, event queue, orchestrator PTY, CLI
 * window. From there the user types the goal into the orchestrator terminal and
 * watches it delegate. No panel, no profile editor, no settings involved.
 *
 * This file is also where the production wiring of the WorkspaceManager lives:
 * {@link createAppWorkspaceManager} is the one place that connects the
 * Electron-free workspace layer to the real agent registry, the real CLI
 * windows and the real settings store. M3's Play button reuses it unchanged.
 */
import { app } from 'electron'
import { getAgentRegistry } from './ipc'
import { startMcpServer, type McpServerHandle } from './mcp/server'
import { closeCliWindow, createCliWindow } from './windows/cliWindow'
import { effectiveProviders, getRoleTemplates, getSettings, settings } from './store/settings'
import { createRunJournal } from './workspace/journal'
import { createRetroSink } from './workspace/retroSink'
import { createWorkspaceManager, type WorkspaceManager } from './workspace/WorkspaceManager'
import type { Workspace } from './workspace/Workspace'
import { REVIEWER_ROLE_ID, WORKER_ROLE_ID } from '@shared/prompts/roles'
import { profileSchema, type Profile } from '@shared/schema/profile'

/** Env var that arms the dev run; its value is the repository path. */
export const DEV_RUN_ENV = 'VERTRAGUS_DEV_RUN'

/**
 * D1: optional goal for the dev run — seeded into the orchestrator exactly
 * like the panel's goal field, so a headless run needs no TUI typing either.
 */
export const DEV_GOAL_ENV = 'VERTRAGUS_DEV_GOAL'

export const DEV_PROFILE_ID = 'dev-run'

/**
 * The synthetic profile of a dev run. Deliberately minimal and hard-coded:
 * everything here is a real production code path except the profile itself, so
 * a failure points at the pipeline and never at a half-configured profile.
 */
export function buildDevProfile(repoPath: string): Profile {
  return profileSchema.parse({
    id: DEV_PROFILE_ID,
    name: 'Dev run',
    repoPath,
    orchestrator: { providerId: 'claude' },
    slots: [
      { id: 'dev-worker', roleId: WORKER_ROLE_ID, providerId: 'claude' },
      { id: 'dev-reviewer', roleId: REVIEWER_ROLE_ID, providerId: 'claude' }
    ],
    maxSubagents: 4
  })
}

/**
 * The production WorkspaceManager: workspace layer + real registry, windows,
 * providers and settings. Providers, role templates and the yolo master are
 * passed as getters so an edit made while the app runs reaches the next
 * workspace without a restart.
 */
export function createAppWorkspaceManager(mcp: McpServerHandle): WorkspaceManager {
  return createWorkspaceManager({
    mcp,
    registry: getAgentRegistry(),
    windows: {
      open: (agentId, options) => {
        createCliWindow(agentId, options)
      },
      close: (agentId) => closeCliWindow(agentId)
    },
    // Transient MCP config files: per user, outside the repository.
    configDir: app.getPath('userData'),
    providers: () => effectiveProviders(),
    roleTemplates: () => getRoleTemplates(),
    yoloMaster: () => getSettings().yoloMaster,
    // The retro loop: run stats and learnings land in the settings store, and
    // the accumulated knowledge returns via the next orchestrator prompt.
    retro: createRetroSink({ store: settings() }),
    // E3: the durable per-run event journal in the repository's .vertragus/.
    journal: (repoPath, workspaceId) => createRunJournal(repoPath, workspaceId)
  })
}

export interface DevRunHandle {
  mcp: McpServerHandle
  manager: WorkspaceManager
  workspace: Workspace
  /** Stop the workspace and close the MCP server — wire this to app quit. */
  stop(): Promise<void>
}

export interface DevRunOptions {
  env?: NodeJS.ProcessEnv
  /** Injected in tests; production starts its own server. */
  startServer?: typeof startMcpServer
  createManager?: (mcp: McpServerHandle) => WorkspaceManager
  log?: (message: string) => void
  logError?: (message: string, error: unknown) => void
}

/**
 * Start the dev workspace when {@link DEV_RUN_ENV} is set; otherwise do
 * nothing. Never throws: a failed dev run must not take the app down with it —
 * the panel is still perfectly usable.
 */
export async function maybeStartDevWorkspace(
  options: DevRunOptions = {}
): Promise<DevRunHandle | undefined> {
  const env = options.env ?? process.env
  const repoPath = env[DEV_RUN_ENV]?.trim()
  if (!repoPath) return undefined

  const log = options.log ?? ((message: string) => console.log(message))
  const logError =
    options.logError ?? ((message: string, error: unknown) => console.error(message, error))

  const startServer = options.startServer ?? startMcpServer
  let mcp: McpServerHandle
  try {
    mcp = await startServer()
  } catch (error) {
    logError('[dev-run] MCP server did not start', error)
    return undefined
  }

  const manager = (options.createManager ?? createAppWorkspaceManager)(mcp)
  try {
    const goal = env[DEV_GOAL_ENV]?.trim()
    const profile = buildDevProfile(repoPath)
    const running = await (goal
      ? manager.startWorkspace(profile, { goal })
      : manager.startWorkspace(profile))
    log(
      `[dev-run] workspace "${running.workspace.name}" on ${repoPath} — ` +
        `orchestrator ${running.orchestrator.name}, MCP on port ${mcp.port}`
    )
    return {
      mcp,
      manager,
      workspace: running.workspace,
      stop: async () => {
        await manager.stopAll()
        await mcp.close()
      }
    }
  } catch (error) {
    logError('[dev-run] workspace did not start', error)
    await mcp.close().catch(() => undefined)
    return undefined
  }
}
