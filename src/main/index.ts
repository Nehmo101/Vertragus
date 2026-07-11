import { app, BrowserWindow } from 'electron'
import { electronApp, optimizer } from '@electron-toolkit/utils'
import { registerIpcHandlers } from '@main/ipc/register'
import { createMainWindow } from '@main/windows'
import { agentManager } from '@main/agents/AgentManager'
import { startMcpServer } from '@main/orchestrator/OrcaMcpServer'

app.whenReady().then(async () => {
  electronApp.setAppUserModelId('dev.nehmo.orca-strator')

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // Start the Orca MCP server before any orchestrator can spawn.
  await startMcpServer().catch((err) => console.error('[OrcaMcp] failed to start', err))

  // Integration self-test (ORCA_MCP_SELFTEST=1): exercise the MCP tools + engine
  // end-to-end with a stubbed runTask, then exit.
  if (process.env['ORCA_MCP_SELFTEST']) {
    const { runSelfTest } = await import('@main/orchestrator/selftest')
    await runSelfTest()
    return
  }

  registerIpcHandlers()
  createMainWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

// Never leave orphaned agent PTYs behind.
app.on('before-quit', () => {
  void agentManager.killAll()
})
