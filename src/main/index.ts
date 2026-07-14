import { app, BrowserWindow } from 'electron'
import { electronApp, optimizer } from '@electron-toolkit/utils'
import { installEditMenu } from '@main/editMenu'
import { refreshProcessPathFromSystem } from '@main/providers/processPath'

const smokeUserData = process.env['ORCA_UI_SMOKE_DATA']
if (process.env['ORCA_UI_SMOKE'] && smokeUserData) {
  app.setPath('userData', smokeUserData)
}

let stopAgents: () => Promise<void> = async () => undefined

app.whenReady().then(async () => {
  // Finder-launched macOS apps do not inherit the user's login-shell PATH.
  // Refresh before any provider, Git or MCP process can be discovered/spawned.
  await refreshProcessPathFromSystem()
  const [ipc, agents, mcp, windows, updater] = await Promise.all([
    import('@main/ipc/register'),
    import('@main/agents/AgentManager'),
    import('@main/orchestrator/OrcaMcpServer'),
    import('@main/windows'),
    import('@main/updater')
  ])
  const { agentManager } = agents
  stopAgents = () => agentManager.killAll()
  electronApp.setAppUserModelId('dev.nehmo.orca-strator')
  installEditMenu()

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // Start the Orca MCP server before any orchestrator can spawn.
  await mcp.startMcpServer().catch((err) => console.error('[OrcaMcp] failed to start', err))

  // Integration self-test (ORCA_MCP_SELFTEST=1): exercise the MCP tools + engine
  // end-to-end with a stubbed runTask, then exit.
  if (process.env['ORCA_MCP_SELFTEST']) {
    const { runSelfTest } = await import('@main/orchestrator/selftest')
    await runSelfTest()
    return
  }

  ipc.registerIpcHandlers()
  windows.createMainWindow()
  updater.initializeUpdater()

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
})
