import { writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { app } from 'electron'
import { electronApp, optimizer } from '@electron-toolkit/utils'
import { PtyAgent } from './agents/PtyAgent'
import { resolveLaunch } from './agents/resolveCommand'
import { registerTerminalIpc } from './ipc'
import { createCliWindow } from './windows/cliWindow'
import { createPanelWindow, getPanelWindow } from './windows/panel'

/**
 * Headless smoke hook: <envVar>=<path> boots the window, captures it and exits.
 * Used by the panel smoke script and for owner verification of the glass
 * rendering (panel: VERTRAGUS_PANEL_SCREENSHOT, CLI: VERTRAGUS_CLI_SCREENSHOT).
 */
function armScreenshotHook(win: Electron.BrowserWindow, envVar: string, delayMs = 1_500): void {
  const target = process.env[envVar]
  if (!target) return
  win.webContents.once('did-finish-load', () => {
    setTimeout(async () => {
      try {
        const image = await win.webContents.capturePage()
        await writeFile(target, image.toPNG())
        app.exit(0)
      } catch (error) {
        console.error(`[smoke] capture failed (${envVar}):`, error)
        app.exit(1)
      }
    }, delayMs)
  })
}

// --- M1 dev verification path -------------------------------------------
// VERTRAGUS_DEV_SPAWN=<command line> spawns one real PTY agent after ready and
// opens its CLI window. This is the manual route until M2 wires the real
// spawn pipeline (profiles → workspace → orchestrator).
async function startDevAgent(): Promise<void> {
  const commandLine = process.env.VERTRAGUS_DEV_SPAWN?.trim()
  if (!commandLine) return

  const [command, ...rawArgs] = commandLine.split(/\s+/)
  if (!command) return

  const agentId = 'dev-agent'
  const agent = new PtyAgent()
  const registry = registerTerminalIpc()
  try {
    // PATH/shim resolution is the spawn pipeline's job (M2); here it is what
    // makes `VERTRAGUS_DEV_SPAWN=cmd` work at all.
    const launch = await resolveLaunch(command, rawArgs)
    agent.spawn({ file: launch.file, args: launch.args, cwd: homedir() })
  } catch (error) {
    agent.push(`\x1b[31mSpawn fehlgeschlagen: ${String(error)}\x1b[0m\r\n`)
  }
  registry.registerAgent({
    pty: agent,
    meta: {
      agentId,
      name: 'Caronte',
      role: 'worker',
      roleColor: '#2f7d6d',
      provider: 'dev',
      model: ''
    }
  })
  const win = createCliWindow(agentId, { title: 'Caronte', roleColor: '#2f7d6d' })
  armScreenshotHook(win, 'VERTRAGUS_CLI_SCREENSHOT', 3_000)
}
// --- end M1 dev verification path ---------------------------------------

app.whenReady().then(() => {
  electronApp.setAppUserModelId('org.nehmo.vertragus')

  app.on('browser-window-created', (_event, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  registerTerminalIpc()
  armScreenshotHook(createPanelWindow(), 'VERTRAGUS_PANEL_SCREENSHOT')
  void startDevAgent()

  app.on('activate', () => {
    if (!getPanelWindow()) createPanelWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
