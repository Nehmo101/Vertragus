import { homedir } from 'node:os'
import { app, BrowserWindow } from 'electron'
import { electronApp, optimizer } from '@electron-toolkit/utils'
import { allRoleTemplates, roleColor } from '@shared/prompts/roles'
import { PtyAgent } from './agents/PtyAgent'
import { resolveLaunch } from './agents/resolveCommand'
import {
  APP_CHANNELS,
  createStubWorkspaceDirectory,
  registerAppIpc,
  toPanelSettings,
  type WorkspaceDirectory,
  type WorkspaceSummary
} from './appIpc'
import { createAppVoice, installDefaultVoicePermissions, type AppVoice } from './appVoice'
import { createAppWorkspaceManager, maybeStartDevWorkspace, type DevRunHandle } from './devRun'
import { registerTerminalIpc } from './ipc'
import { startMcpServer, type McpServerHandle } from './mcp/server'
import { getProfile, getRoleTemplates, getSettings, settings } from './store/settings'
import { createCliWindow, focusCliWindow } from './windows/cliWindow'
import { cliFocusTargets, focusWorkspaceAgents } from './windows/focusWorkspace'
import {
  hideAllHotkeyStatus,
  registerAppHideAllShortcut,
  toggleHideAll,
  unregisterHideAllShortcut
} from './windows/hideAll'
import { createPanelWindow, getPanelWindow, isPanelWindowSender } from './windows/panel'
import { armProfileEditorSmoke, openProfileEditorWindow } from './windows/profileEditor'
import { armProviderEditorSmoke } from './windows/providerEditor'
import { armSettingsWindowSmoke, openSettingsWindow } from './windows/settingsWindow'
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
          active: orchestrator !== undefined,
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
                    state: 'working' as const,
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
    start(profileId, options) {
      const profile = getProfile(profileId)
      if (!profile) throw new Error(`Unbekanntes Profil ${profileId}`)
      return manager.startWorkspace(profile, options)
    },
    stop: (workspaceId) => manager.stopWorkspace(workspaceId),
    sendToOrchestrator(workspaceId, text) {
      const workspace = manager.get(workspaceId)
      if (!workspace) throw new Error(`Unbekannter Workspace ${workspaceId}`)
      const orchestrator = workspace.orchestrator
      if (!orchestrator) {
        throw new Error(`Workspace ${workspaceId} hat keinen aktiven Orchestrator.`)
      }
      return workspace.sendToAgent(orchestrator.agentId, text)
    },
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
    removeWorktree: (profileId, worktreePath) => cleanup.remove(profileId, worktreePath)
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
let appVoice: AppVoice | undefined

function sendToPanel(channel: string, payload: unknown): void {
  const win = getPanelWindow()
  if (win && !win.webContents.isDestroyed()) win.webContents.send(channel, payload)
}

function broadcastPanelSettings(): void {
  const value = toPanelSettings(getSettings(), hideAllHotkeyStatus(), app.isPackaged)
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.webContents.isDestroyed()) continue
    win.webContents.send(APP_CHANNELS.eventSettings, value)
    win.webContents.send(APP_CHANNELS.eventAppearance, value.appearance)
  }
}

function attachVoice(directory: WorkspaceDirectory): AppVoice {
  const voice = createAppVoice({
    directory,
    store: () => settings(),
    hideAll: () => toggleHideAll(),
    openSettings: () => openSettingsWindow(),
    openProfileEditor: (profileId) => openProfileEditorWindow(profileId),
    quit: () => app.quit(),
    onYoloChanged: () => broadcastPanelSettings(),
    sendToPanel
  })
  appVoice = voice
  return voice
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
    registerAppIpc(directory, attachVoice(directory).port)
  } catch (error) {
    console.error('[boot] MCP server did not start — panel runs without workspaces:', error)
    registerAppIpc(undefined, attachVoice(createStubWorkspaceDirectory()).port)
  }

  // Mic capture is a panel-window permission; CLI windows must not get it.
  installDefaultVoicePermissions((id) => isPanelWindowSender(id))

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

  // After the panel exists so a stored-on session can ask for the mic.
  const voiceOn = getSettings().voice.enabled
  if (voiceOn) void appVoice?.port.setEnabled(true)
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

app.on('before-quit', () => {
  // devRun shares the app's manager/server, so stopping twice must be safe.
  appVoice?.dispose()
  appVoice = undefined
  void devRun?.stop().catch(() => undefined)
  void appManager?.stopAll().catch(() => undefined)
  void appMcp?.close().catch(() => undefined)
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
