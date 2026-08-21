import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { BrowserWindow, shell } from 'electron'
import { is } from '@electron-toolkit/utils'
import { getSettings } from '@main/store/settings'
import { glassSurface, type GlassEnvironment, type GlassTheme } from './glassSurface'
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
 * The session facts behind the transparency decision. Read per window, not
 * captured at boot: `appearance.translucent` is a live setting, and a window
 * opened after the user turned it off must respect it — `transparent` cannot
 * be changed once a BrowserWindow exists, so this is the only moment it can.
 * A store that cannot be read must not take the window with it; the mockup's
 * translucent default carries.
 */
function glassEnvironment(): { env: GlassEnvironment; theme: GlassTheme } {
  let translucent = true
  let theme: GlassTheme = 'dark'
  try {
    const ui = getSettings().ui
    translucent = ui.appearance.translucent
    theme = ui.theme
  } catch {
    // Unreadable store — see above.
  }
  return {
    env: {
      platform: process.platform,
      translucent,
      sessionType: process.env['XDG_SESSION_TYPE'],
      waylandDisplay: process.env['WAYLAND_DISPLAY'],
      currentDesktop: process.env['XDG_CURRENT_DESKTOP'],
      forced: process.env['VERTRAGUS_TRANSPARENT']
    },
    theme
  }
}

/**
 * All glass windows share this base: frameless, no OS chrome, and see-through
 * wherever the display server can composite it. The transparency decision
 * itself lives in `glassSurface.ts` — this is the one place that applies it,
 * so a Linux session without a compositor falls back to an opaque themed
 * window for EVERY window at once instead of per call site.
 */
export function glassWindowOptions(): Electron.BrowserWindowConstructorOptions {
  const { env, theme } = glassEnvironment()
  return {
    frame: false,
    ...glassSurface(env, theme),
    show: false,
    webPreferences: baseWebPreferences()
  }
}
