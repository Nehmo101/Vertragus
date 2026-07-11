import { app, BrowserWindow } from 'electron'
import { electronApp, optimizer } from '@electron-toolkit/utils'
import { registerIpcHandlers } from '@main/ipc/register'
import { createMainWindow } from '@main/windows'
import { agentManager } from '@main/agents/AgentManager'

app.whenReady().then(() => {
  electronApp.setAppUserModelId('dev.nehmo.orca-strator')

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

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
