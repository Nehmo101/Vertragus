import { app, BrowserWindow, globalShortcut, Menu, nativeImage, Tray } from 'electron'
import { join } from 'node:path'
import { electronApp, optimizer } from '@electron-toolkit/utils'
import { installEditMenu } from '@main/editMenu'
import { brandEnv } from '@main/env'
import { headlessStartupLines, isHeadlessMode } from '@main/headlessMode'
import { refreshProcessPathFromSystem } from '@main/providers/processPath'

/** VERTRAGUS_HEADLESS=1: run engine + gateway without any window (VPS/daemon). */
const headless = isHeadlessMode()

/** Global shortcut that toggles the free voice overlay from anywhere. */
const VOICE_OVERLAY_SHORTCUT = 'CommandOrControl+Shift+Space'
let voiceTray: Tray | null = null

const smokeUserData = brandEnv('UI_SMOKE_DATA')
if (brandEnv('UI_SMOKE') && smokeUserData) {
  app.setPath('userData', smokeUserData)
}

// E2E smoke (scripts/e2e-smoke.mjs): run the real app against a seeded,
// isolated userData directory. Unlike UI_SMOKE the app stays open and is
// driven from outside (Playwright), so only the data dir is redirected and
// background side effects (tray, retro sync) are skipped below.
const e2eUserData = brandEnv('E2E_USER_DATA')
if (e2eUserData) {
  app.setPath('userData', e2eUserData)
}

/** Hard ceiling for the ordered quit sequence before app.exit() forces the end. */
const SHUTDOWN_DEADLINE_MS = 8_000

let stopAgents: () => Promise<void> = async () => undefined
let stopRemote: () => Promise<void> = async () => undefined
let flushSessionState: () => void = () => undefined
let shutdownStarted = false

app.whenReady().then(async () => {
  // Finder-launched macOS apps do not inherit the user's login-shell PATH.
  // Refresh before any provider, Git or MCP process can be discovered/spawned.
  await refreshProcessPathFromSystem()
  const [ipc, agents, mcp, remote, windows, updater] = await Promise.all([
    import('@main/ipc/register'),
    import('@main/agents/AgentManager'),
    import('@main/orchestrator/VertragusMcpServer'),
    import('@main/remote'),
    import('@main/windows'),
    import('@main/updater')
  ])
  const { agentManager } = agents
  stopAgents = () => agentManager.killAll()
  stopRemote = () => remote.stopRemoteGateway()
  electronApp.setAppUserModelId('dev.nehmo.vertragus')
  installEditMenu()

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // Start the Vertragus MCP server before any orchestrator can spawn.
  await mcp.startMcpServer().catch((err) => console.error('[VertragusMcp] failed to start', err))

  // Integration self-test (VERTRAGUS_MCP_SELFTEST=1): exercise the MCP tools + engine
  // end-to-end with a stubbed runTask, then exit.
  if (brandEnv('MCP_SELFTEST')) {
    const { runSelfTest } = await import('@main/orchestrator/selftest')
    await runSelfTest()
    return
  }

  if (brandEnv('REMOTE_SELFTEST')) {
    const { runRemoteSelfTest } = await import('@main/remote/selftestRemote')
    await runRemoteSelfTest()
    return
  }

  // Rehydrate persisted workspace sessions before the remote gateway seeds its
  // read model and before IPC + window exist, so every consumer's first look at
  // the registry already contains them. Spawns no agent processes.
  const sessionRestore = await import('@main/orchestrator/sessionRestore')
  try {
    const restore = sessionRestore.prepareSessionPersistence()
    if (restore.restoredSessions > 0) {
      console.info(
        `[Sessions] ${restore.restoredSessions} Workspace-Session(s) wiederhergestellt` +
          (restore.cleanShutdown ? '' : ' (letzter Lauf endete unerwartet)')
      )
    }
  } catch (error) {
    console.error('[Sessions] restore failed', error)
  }
  flushSessionState = () => sessionRestore.finalizeSessionPersistence()

  await remote.startRemoteGatewayIfEnabled().catch((error) => {
    console.error('[MissionControl] secure startup refused', error)
  })

  ipc.registerIpcHandlers()
  if (headless) {
    // No window, tray, shortcut or updater surface — the Mission-Control
    // gateway is the only control plane. Warn loudly when it is disabled.
    for (const line of headlessStartupLines(remote.remoteService.status().enabled)) {
      console.info(line)
    }
  } else {
    windows.createMainWindow()
    updater.initializeUpdater()
  }

  // Voice overlay: reachable from anywhere via a global shortcut and a tray icon.
  // Both just toggle the overlay window; the overlay owns no privileged rights.
  if (!brandEnv('UI_SMOKE') && !e2eUserData && !headless) {
    try {
      globalShortcut.register(VOICE_OVERLAY_SHORTCUT, () => windows.toggleVoiceOverlay())
    } catch (error) {
      console.warn('[Voice] global shortcut registration failed', error)
    }
    try {
      const trayIcon = nativeImage.createFromPath(join(__dirname, '../renderer/favicon.png'))
      voiceTray = new Tray(trayIcon.isEmpty() ? nativeImage.createEmpty() : trayIcon)
      voiceTray.setToolTip('Vertragus')
      voiceTray.setContextMenu(
        Menu.buildFromTemplate([
          { label: 'Sprachassistent umschalten', click: () => windows.toggleVoiceOverlay() },
          { type: 'separator' },
          { label: 'Beenden', click: () => app.quit() }
        ])
      )
      voiceTray.on('click', () => windows.toggleVoiceOverlay())
    } catch (error) {
      console.warn('[Voice] tray setup failed', error)
    }
  }

  // Retro-Sync: drain queued retro exports on start + coarse retry interval.
  if (!brandEnv('UI_SMOKE') && !e2eUserData) {
    const retroExport = await import('@main/orchestrator/retroExport')
    retroExport.startRetroSyncScheduler()
  }

  app.on('activate', () => {
    if (!headless && BrowserWindow.getAllWindows().length === 0) windows.createMainWindow()
  })
})

app.on('window-all-closed', () => {
  // A headless host has no windows by design and must keep running.
  if (!headless && process.platform !== 'darwin') app.quit()
})

// Ordered shutdown: persist session state first (synchronous local writes),
// then terminate agent PTYs and the remote gateway, bounded by a hard
// deadline. Without preventDefault the process would exit before the
// fire-and-forget cleanup ever ran — losing up to 2 s of orchestrator state.
app.on('before-quit', (event) => {
  if (shutdownStarted) return
  shutdownStarted = true
  event.preventDefault()
  try {
    flushSessionState()
  } catch (error) {
    console.warn('[Shutdown] session flush failed', error)
  }
  const shutdown = (async () => {
    await stopAgents().catch((error) => console.warn('[Shutdown] agent stop failed', error))
    await stopRemote().catch((error) => console.warn('[Shutdown] remote stop failed', error))
  })()
  const deadline = new Promise<void>((resolve) => {
    setTimeout(resolve, SHUTDOWN_DEADLINE_MS)
  })
  void Promise.race([shutdown, deadline]).finally(() => app.exit(0))
})

app.on('will-quit', () => {
  globalShortcut.unregisterAll()
  voiceTray?.destroy()
  voiceTray = null
})
