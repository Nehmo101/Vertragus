import { writeFile } from 'node:fs/promises'
import { app } from 'electron'
import { electronApp, optimizer } from '@electron-toolkit/utils'
import { createPanelWindow, getPanelWindow } from './windows/panel'

/**
 * Headless smoke hook: VERTRAGUS_PANEL_SCREENSHOT=<path> boots the panel,
 * captures it and exits. Used by the panel smoke script and for owner
 * verification of the glass rendering.
 */
function armScreenshotHook(win: Electron.BrowserWindow): void {
  const target = process.env.VERTRAGUS_PANEL_SCREENSHOT
  if (!target) return
  win.webContents.once('did-finish-load', () => {
    setTimeout(async () => {
      try {
        const image = await win.webContents.capturePage()
        await writeFile(target, image.toPNG())
        app.exit(0)
      } catch (error) {
        console.error('[panel-smoke] capture failed:', error)
        app.exit(1)
      }
    }, 1_500)
  })
}

app.whenReady().then(() => {
  electronApp.setAppUserModelId('org.nehmo.vertragus')

  app.on('browser-window-created', (_event, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  armScreenshotHook(createPanelWindow())

  app.on('activate', () => {
    if (!getPanelWindow()) createPanelWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
