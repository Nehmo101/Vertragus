import { homedir, networkInterfaces } from 'node:os'
import { join } from 'node:path'
import { app, safeStorage, ipcMain } from 'electron'
import { electronApp, optimizer } from '@electron-toolkit/utils'
import { mainMessages, readLocale } from '@shared/mainMessages'
import { allRoleTemplates, roleColor } from '@shared/prompts/roles'
import { PtyAgent } from './agents/PtyAgent'
import { resolveLaunch } from './agents/resolveCommand'
import { registerAppIpc, type WorkspaceDirectory, type WorkspaceSummary } from './appIpc'
import { createAppWorkspaceManager, maybeStartDevWorkspace, type DevRunHandle } from './devRun'
import { registerTerminalIpc } from './ipc'
import { startMcpServer, type McpServerHandle } from './mcp/server'
import { getProfile, getProfiles, getRoleTemplates, getSettings, setSetting } from './store/settings'
import { createCliWindow, focusCliWindow } from './windows/cliWindow'
import { cliFocusTargets, focusWorkspaceAgents } from './windows/focusWorkspace'
import { registerAppHideAllShortcut, unregisterHideAllShortcut } from './windows/hideAll'
import { createPanelWindow } from './windows/panel'
import { armProfileEditorSmoke } from './windows/profileEditor'
import { armProviderEditorSmoke } from './windows/providerEditor'
import {
  armSettingsWindowSmoke,
  isSettingsWindowSender,
  listSettingsWindows
} from './windows/settingsWindow'
import { createRemoteController, type RemoteController } from './remote/controller'
import { registerRemoteIpc } from './remote/ipc'
import { bindOptions } from './remote/interfaces'
import { getAgentRegistry } from './ipc'
import { armWindowCapture } from './windows/smokeCapture'
import { armZoneOverlaySmoke } from './windows/zoneOverlay'
import { startAppUpdater } from './updater'
import type { WorkspaceManager } from './workspace/WorkspaceManager'
import { createWorktreeCleanup } from './workspace/worktreeCleanup'

/**
 * Headless smoke hook: <envVar>=<path> boots the window, captures it and exits.
 * Used by the panel smoke script and for owner verification of the glass
 * rendering (panel: VERTRAGUS_PANEL_SCREENSHOT, CLI: VERTRAGUS_CLI_SCREENSHOT).
 * The capture mechanics (show, wait for paint, retry) live in smokeCapture.
 */
function armScreenshotHook(win: Electron.BrowserWindow, envVar: string, delayMs = 1_500): void {
  armWindowCapture(win, envVar, envVar, delayMs)
}

/** Adapter: WorkspaceManager → the view the panel draws. */
function panelDirectory(manager: WorkspaceManager, mcp: McpServerHandle): WorkspaceDirectory {
  const roleLabel = (roleId: string): string =>
    allRoleTemplates(getRoleTemplates()).find((role) => role.id === roleId)?.name ?? roleId

  const pendingOf = (workspaceId: string, agentId: string): string | undefined =>
    mcp.pendingQuestion(workspaceId, agentId)

  // Active paths across ALL workspaces, not just the asking profile's: two
  // profiles may point at the same repository, and an agent of either must
  // never show up as removable.
  const cleanup = createWorktreeCleanup({
    repoPathFor: (profileId) => getProfile(profileId)?.repoPath,
    activeWorktreePaths: () =>
      manager.list().flatMap((workspace) => workspace.activeWorktreePaths())
  })

  return {
    list: () =>
      manager.list().map<WorkspaceSummary>((ws) => {
        const orchestrator = ws.orchestrator
        const roleIds = [...new Set(ws.profile.slots.map((slot) => slot.roleId))]
        const taskText = mcp.workspaceTask(ws.workspaceId)
        return {
          workspaceId: ws.workspaceId,
          name: ws.name,
          profileId: ws.profileId,
          profileName: ws.profile.name,
          // Not "was an orchestrator ever started" — a crashed orchestrator
          // must grey the card out even though its record (and window) stay.
          active: ws.orchestratorAlive,
          ...(taskText ? { taskText } : {}),
          agents: [
            ...(orchestrator
              ? [
                  {
                    agentId: orchestrator.agentId,
                    name: orchestrator.name,
                    roleId: 'orchestrator',
                    roleLabel: 'Orchestrator',
                    roleColor: roleColor('orchestrator'),
                    state: ws.orchestratorAlive ? ('working' as const) : ('stopped' as const),
                    ...(pendingOf(ws.workspaceId, orchestrator.agentId)
                      ? { pendingQuestion: pendingOf(ws.workspaceId, orchestrator.agentId) }
                      : {})
                  }
                ]
              : []),
            ...ws.listAgents().map((agent) => {
              const pendingQuestion = pendingOf(ws.workspaceId, agent.agentId)
              return {
                agentId: agent.agentId,
                name: agent.name,
                roleId: agent.role,
                roleLabel: roleLabel(agent.role),
                roleColor: roleColor(agent.role, roleIds.indexOf(agent.role)),
                state:
                  agent.status === 'working'
                    ? ('working' as const)
                    : agent.status === 'starting'
                      ? ('waiting' as const)
                      : ('stopped' as const),
                ...(pendingQuestion ? { pendingQuestion } : {})
              }
            })
          ]
        }
      }),
    start(profileId) {
      const profile = getProfile(profileId)
      if (!profile) {
        const locale = readLocale(() => getSettings().ui.locale)
        throw new Error(mainMessages(locale).unknownProfile(profileId))
      }
      return manager.startWorkspace(profile)
    },
    stop: (workspaceId) => manager.stopWorkspace(workspaceId),
    focusAgent: (agentId) => focusCliWindow(agentId),
    focusWorkspace(workspaceId) {
      const workspace = manager.get(workspaceId)
      if (!workspace) return
      // Orchestrator first (stable focus target), then subagents in start order.
      const agentIds = [
        ...(workspace.orchestrator ? [workspace.orchestrator.agentId] : []),
        ...workspace.listAgents().map((agent) => agent.agentId)
      ]
      focusWorkspaceAgents(agentIds, { windows: cliFocusTargets })
    },
    listStaleWorktrees: (profileId) => cleanup.listStale(profileId),
    removeWorktree: (profileId, worktreePath) => cleanup.remove(profileId, worktreePath),
    // The push channel: appIpc turns this into ev:workspaces, which is what
    // lets the panel drop its poll — badges and card states update the moment
    // something happens instead of up to four seconds later.
    onChange: (listener) => manager.onChange(listener)
  }
}

// --- M1 dev verification path -------------------------------------------
// VERTRAGUS_DEV_SPAWN=<command line> spawns one real PTY agent after ready and
// opens its CLI window — kept as the CLI-window screenshot smoke.
async function startDevAgent(): Promise<void> {
  const commandLine = process.env.VERTRAGUS_DEV_SPAWN?.trim()
  if (!commandLine) return

  const [command, ...rawArgs] = commandLine.split(/\s+/)
  if (!command) return

  const agentId = 'dev-agent'
  const agent = new PtyAgent()
  const registry = registerTerminalIpc()
  try {
    const launch = await resolveLaunch(command, rawArgs)
    agent.spawn({ file: launch.file, args: launch.args, cwd: homedir() })
  } catch (error) {
    agent.push(`\x1b[31mSpawn fehlgeschlagen: ${String(error)}\x1b[0m\r\n`)
  }
  registry.registerAgent({
    pty: agent,
    meta: {
      agentId,
      name: 'Caronte',
      role: 'worker',
      roleColor: '#2f7d6d',
      provider: 'dev',
      model: ''
    }
  })
  const win = createCliWindow(agentId, { title: 'Caronte', roleColor: '#2f7d6d' })
  armScreenshotHook(win, 'VERTRAGUS_CLI_SCREENSHOT', 3_000)
}
// --- end M1 dev verification path ---------------------------------------

let appMcp: McpServerHandle | undefined
let appManager: WorkspaceManager | undefined
let devRun: DevRunHandle | undefined
let remote: RemoteController | undefined

/** The built web client sits next to the main bundle: out/main → out/remote. */
function remoteStaticRoot(): string {
  return join(__dirname, '..', 'remote')
}

/**
 * Wire the remote-access controller to the app: the command gateway delegates
 * to the same WorkspaceDirectory the panel uses, terminals come from the shared
 * registry, and workspace changes fan out over the same manager feed. The
 * pairing token is encrypted at rest with Electron safeStorage.
 */
function buildRemoteController(
  directory: WorkspaceDirectory,
  manager: WorkspaceManager
): RemoteController {
  return createRemoteController({
    readSettings: () => getSettings().remote,
    writeSettings: (next) => setSetting('remote', next),
    networkInterfaces: () => networkInterfaces() as Parameters<typeof bindOptions>[0],
    secrets: {
      encrypt: (plain) =>
        safeStorage.isEncryptionAvailable()
          ? safeStorage.encryptString(plain).toString('base64')
          : // No OS keychain (headless Linux CI): store a marked plaintext so
            // the round trip still works. Real installs always have safeStorage.
            `plain:${Buffer.from(plain).toString('base64')}`,
      decrypt: (cipher) => {
        try {
          if (cipher.startsWith('plain:')) return Buffer.from(cipher.slice(6), 'base64').toString()
          return safeStorage.decryptString(Buffer.from(cipher, 'base64'))
        } catch {
          return undefined
        }
      }
    },
    staticRoot: remoteStaticRoot(),
    serverBase: {
      gateway: {
        listWorkspaces: () => directory.list(),
        listProfiles: () =>
          getProfiles().map((profile) => ({
            id: profile.id,
            name: profile.name,
            repoPath: profile.repoPath
          })),
        startWorkspace: (profileId) => directory.start(profileId),
        stopWorkspace: (workspaceId) => directory.stop(workspaceId)
      },
      terminals: () => getAgentRegistry().terminals(),
      onWorkspaceChange: (listener) => manager.onChange(listener),
      locale: () => getSettings().ui.locale,
      theme: () => getSettings().ui.theme
    }
  })
}

app.whenReady().then(async () => {
  electronApp.setAppUserModelId('org.nehmo.vertragus')

  app.on('browser-window-created', (_event, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  registerTerminalIpc()

  // One MCP server + one WorkspaceManager serve both the panel's play button
  // and the dev run; the dev run merely injects them instead of starting its
  // own pair.
  //
  // This is the ONLY registerAppIpc call in the app: the first call binds the
  // workspace directory for good (see the guard there), so a second one
  // anywhere else would silently decide that the panel talks to the refusing
  // stub instead of the real manager.
  try {
    appMcp = await startMcpServer()
    appManager = createAppWorkspaceManager(appMcp)
    const directory = panelDirectory(appManager, appMcp)
    registerAppIpc(directory)
    // Remote access — off by default. The controller does nothing until the
    // user enables it in settings; wiring it here gives the settings channels
    // a live controller to drive.
    remote = buildRemoteController(directory, appManager)
    const remoteIpc = registerRemoteIpc({
      ipcMain: ipcMain as unknown as Parameters<typeof registerRemoteIpc>[0]['ipcMain'],
      controller: remote,
      bindOptions: () => bindOptions(networkInterfaces() as Parameters<typeof bindOptions>[0]),
      isSettingsSender: (id) => isSettingsWindowSender(id),
      broadcast: (channel, payload) => {
        for (const { window } of listSettingsWindows()) {
          if (!window.isDestroyed()) window.webContents.send(channel, payload)
        }
      }
    })
    // Resume a server the user had enabled before the last quit.
    if (getSettings().remote.enabled) {
      await remote.apply({ enabled: true })
      remoteIpc.emit()
    }
  } catch (error) {
    console.error('[boot] MCP server did not start — panel runs without workspaces:', error)
    registerAppIpc()
  }

  // Hide-all: the global hotkey. A failed registration is not fatal — the
  // status reaches the panel through settings:get, and the eye still works.
  const hotkey = registerAppHideAllShortcut()
  if (!hotkey.registered) console.warn('[boot] hide-all hotkey:', hotkey.error)

  // Self-update: checks once now and every six hours after that. Inert in a dev
  // run, so this line is a no-op for everyone except an installed Vertragus.
  // It runs AFTER registerAppIpc, so the first state push has a listener.
  startAppUpdater()

  // Env-gated verification hooks; no-ops in every normal run. All of them live
  // here, next to each other — a window smoke hook hidden inside an IPC
  // registration is how you end up calling that registration twice.
  armScreenshotHook(createPanelWindow(), 'VERTRAGUS_PANEL_SCREENSHOT')
  armProfileEditorSmoke()
  armProviderEditorSmoke()
  armSettingsWindowSmoke()
  armZoneOverlaySmoke()
  void startDevAgent()
  if (appMcp && appManager) {
    const mcp = appMcp
    const manager = appManager
    devRun = await maybeStartDevWorkspace({
      startServer: async () => mcp,
      createManager: () => manager
    })
    // Owner verification of the real orchestrator boot: capture its CLI
    // window (real claude with MCP attach) and exit.
    if (devRun && process.env.VERTRAGUS_DEV_RUN_SCREENSHOT) {
      const { getCliWindow } = await import('./windows/cliWindow')
      const win = getCliWindow(devRun.workspace.orchestrator?.agentId ?? '')
      if (win) armScreenshotHook(win, 'VERTRAGUS_DEV_RUN_SCREENSHOT', 12_000)
    }
  }

  // Also the way back from the panel's − : createPanelWindow restores and
  // focuses the existing window, so activating the app un-minimizes it.
  app.on('activate', () => {
    createPanelWindow()
  })
})

app.on('will-quit', () => {
  // A leaked global shortcut outlives the process on Windows.
  unregisterHideAllShortcut()
})

/**
 * Ceiling for the quit-time shutdown. Covers the POSIX SIGTERM→SIGKILL grace
 * (5 s) plus taskkill latency; a wedged kill must not wedge quitting forever.
 */
const QUIT_SHUTDOWN_CEILING_MS = 8_000

let quitting = false

app.on('before-quit', (event) => {
  if (quitting) return
  quitting = true
  // Electron would exit before the fire-and-forget kills land, orphaning
  // yolo-mode CLI processes. Hold the quit, await the kills (bounded), then
  // exit for real — the second pass falls through the `quitting` guard.
  event.preventDefault()
  const shutdown = (async () => {
    // devRun shares the app's manager/server, so stopping twice must be safe.
    await remote?.stop().catch(() => undefined)
    await devRun?.stop().catch(() => undefined)
    await appManager?.stopAll({ awaitExitMs: QUIT_SHUTDOWN_CEILING_MS - 1_000 }).catch(() => undefined)
    await appMcp?.close().catch(() => undefined)
  })()
  const ceiling = new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, QUIT_SHUTDOWN_CEILING_MS)
    timer.unref?.()
  })
  void Promise.race([shutdown, ceiling]).finally(() => app.exit())
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
