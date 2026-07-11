/**
 * Window management: frameless main window (custom title bar per design),
 * pop-out windows for individual agent panes, and broadcast to all windows.
 */
import { app, BrowserWindow, shell } from 'electron'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { is } from '@electron-toolkit/utils'

const BG = '#080c15'

function loadRoute(win: BrowserWindow, hash: string): void {
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(`${process.env['ELECTRON_RENDERER_URL']}#${hash}`)
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'), { hash })
  }
}

function baseWebPreferences(): Electron.WebPreferences {
  return {
    preload: join(__dirname, '../preload/index.js'),
    sandbox: false,
    contextIsolation: true
  }
}

export function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1180,
    minHeight: 720,
    show: false,
    frame: false, // custom title bar (design: window controls in-app)
    autoHideMenuBar: true,
    backgroundColor: BG,
    title: 'Orca-Strator',
    webPreferences: baseWebPreferences()
  })

  win.on('ready-to-show', () => win.show())
  win.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // Headless UI capture for verification/CI: ORCA_SCREENSHOT=<file.png>
  const shotPath = process.env['ORCA_SCREENSHOT']
  if (shotPath) {
    win.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        try {
          const image = await win.webContents.capturePage()
          writeFileSync(shotPath, image.toPNG())
        } finally {
          app.quit()
        }
      }, 4500)
    })
  }

  loadRoute(win, '/')
  return win
}

/** Pop out a single agent pane into its own OS window (native frame). */
export function createPaneWindow(agentId: string): BrowserWindow {
  const win = new BrowserWindow({
    width: 760,
    height: 520,
    minWidth: 420,
    minHeight: 300,
    autoHideMenuBar: true,
    backgroundColor: BG,
    title: `Orca-Strator — ${agentId}`,
    webPreferences: baseWebPreferences()
  })
  loadRoute(win, `/pane/${agentId}`)
  return win
}

export function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload)
  }
}
