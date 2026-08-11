import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { BrowserWindow, shell } from 'electron'
import { is } from '@electron-toolkit/utils'
import { protectWebContents } from './navigation'

/**
 * Every Vertragus window is sandboxed and context-isolated. The security
 * contract test greps this file — keep the literal flags in place.
 */
export function baseWebPreferences(): Electron.WebPreferences {
  return {
    preload: join(__dirname, '../preload/index.js'),
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
    webSecurity: true
  }
}

export function secureWindow(win: BrowserWindow): void {
  protectWebContents(win.webContents, {
    developmentUrl: process.env['ELECTRON_RENDERER_URL'],
    packagedRendererUrl: pathToFileURL(join(__dirname, '../renderer/index.html')).toString(),
    openExternal: (url) => shell.openExternal(url)
  })
}

export function loadRoute(win: BrowserWindow, hash: string): void {
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(`${process.env['ELECTRON_RENDERER_URL']}#${hash}`)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'), { hash })
  }
}

/**
 * All glass windows share this base: frameless, transparent, no OS chrome.
 * Transparency decisions are centralized here so a platform fallback (e.g.
 * Linux without a compositor) only has to happen in one place.
 */
export function glassWindowOptions(): Electron.BrowserWindowConstructorOptions {
  return {
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    show: false,
    webPreferences: baseWebPreferences()
  }
}
