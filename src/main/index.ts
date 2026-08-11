import { app } from 'electron'
import { electronApp, optimizer } from '@electron-toolkit/utils'
import { createPanelWindow, getPanelWindow } from './windows/panel'

app.whenReady().then(() => {
  electronApp.setAppUserModelId('org.nehmo.vertragus')

  app.on('browser-window-created', (_event, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  createPanelWindow()

  app.on('activate', () => {
    if (!getPanelWindow()) createPanelWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
