import { app, BrowserWindow, globalShortcut, Menu, nativeImage, Tray } from 'electron'
import { join } from 'node:path'
import { electronApp, optimizer } from '@electron-toolkit/utils'
import { installEditMenu } from '@main/editMenu'
import { brandEnv } from '@main/env'
import { refreshProcessPathFromSystem } from '@main/providers/processPath'

/** Global shortcut that toggles the free voice overlay from anywhere. */
const VOICE_OVERLAY_SHORTCUT = 'CommandOrControl+Shift+Space'
let voiceTray: Tray | null = null

const smokeUserData = brandEnv('UI_SMOKE_DATA')
if (brandEnv('UI_SMOKE') && smokeUserData) {
  app.setPath('userData', smokeUserData)
}

let stopAgents: () => Promise<void> = async () => undefined
let stopRemote: () => Promise<void> = async () => undefined

app.whenReady().then(async () => {
  // Finder-launched macOS apps do not inherit the user's login-shell PATH.
  // Refresh before any provider, Git or MCP process can be discovered/spawned.
  await refreshProcessPathFromSystem()
  const [ipc, agents, mcp, remote, windows, updater] = await Promise.all([
    import('@main/ipc/register'),
    import('@main/agents/AgentManager'),
    import('@main/orchestrator/OrcaMcpServer'),
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

  // Start the Orca MCP server before any orchestrator can spawn.
  await mcp.startMcpServer().catch((err) => console.error('[OrcaMcp] failed to start', err))

  // Integration self-test (ORCA_MCP_SELFTEST=1): exercise the MCP tools + engine
  // end-to-end with a stubbed runTask, then exit.
  if (brandEnv('MCP_SELFTEST')) {
    const { runSelfTest } = await import('@main/orchestrator/selftest')
    await runSelfTest()
    return
  }

  if (process.env['ORCA_REMOTE_SELFTEST']) {
    const { runRemoteSelfTest } = await import('@main/remote/selftestRemote')
    await runRemoteSelfTest()
    return
  }

  await remote.startRemoteGatewayIfEnabled().catch((error) => {
    console.error('[MissionControl] secure startup refused', error)
  })

  ipc.registerIpcHandlers()
  windows.createMainWindow()
  updater.initializeUpdater()

  // Voice overlay: reachable from anywhere via a global shortcut and a tray icon.
  // Both just toggle the overlay window; the overlay owns no privileged rights.
  if (!brandEnv('UI_SMOKE')) {
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
  if (!brandEnv('UI_SMOKE')) {
    const retroExport = await import('@main/orchestrator/retroExport')
    retroExport.startRetroSyncScheduler()
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) windows.createMainWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

// Never leave orphaned agent PTYs behind.
app.on('before-quit', () => {
  void stopAgents()
  void stopRemote()
})

app.on('will-quit', () => {
  globalShortcut.unregisterAll()
  voiceTray?.destroy()
  voiceTray = null
})
