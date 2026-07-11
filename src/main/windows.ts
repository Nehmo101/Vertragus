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

  // Headless UI capture for verification/CI: ORCA_SCREENSHOT=<file.png>.
  // ORCA_DEMO_DAG=1 pushes demo agents + task graph through the real render path.
  const shotPath = process.env['ORCA_SCREENSHOT']
  if (shotPath) {
    win.webContents.once('did-finish-load', () => {
      if (process.env['ORCA_DEMO_DAG']) {
        setTimeout(() => pushDemoState(win), 2500)
      }
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

/** Dev/CI only: feed representative Phase-2 state through the normal push channels. */
function pushDemoState(win: BrowserWindow): void {
  const now = Date.now()
  const agents = [
    { id: 'orch-01', provider: 'claude', model: 'fable', role: 'Orchestrator · plant & verteilt', kind: 'orchestrator', mode: 'interactive', yolo: false, workingDir: '~/repos/checkout', status: 'running', startedAt: now },
    { id: 'task-02', provider: 'codex', model: 'gpt-5.6', role: 'Task · worker', kind: 'sub', mode: 'task', taskId: 't-1', yolo: false, workingDir: '.', worktree: '.', status: 'running', startedAt: now },
    { id: 'task-03', provider: 'codex', model: 'gpt-5.6', role: 'Task · worker', kind: 'sub', mode: 'task', taskId: 't-2', yolo: true, workingDir: '.', worktree: '.', status: 'running', startedAt: now },
    { id: 'task-04', provider: 'codex', model: 'gpt-5.6', role: 'Task · worker', kind: 'sub', mode: 'task', taskId: 't-3', yolo: false, workingDir: '.', status: 'stopped', startedAt: now }
  ]
  const snapshot = {
    goal: { id: 'epic-4471', title: 'Checkout-Flow v2', active: true },
    tasks: [
      { id: 't-1', title: 'API · POST /checkout', role: 'worker', agentId: 'task-02', provider: 'codex', model: 'gpt-5.6', status: 'running', createdAt: now },
      { id: 't-2', title: 'E2E · Checkout-Spec', role: 'worker', agentId: 'task-03', provider: 'codex', model: 'gpt-5.6', status: 'running', yolo: true, createdAt: now + 1 },
      { id: 't-3', title: 'DB · Migration', role: 'worker', agentId: 'task-04', provider: 'codex', model: 'gpt-5.6', status: 'success', progress: 100, note: 'Migration erstellt, Tests grün.', createdAt: now + 2, finishedAt: now + 3 },
      { id: 't-4', title: 'Review · PR #482', role: 'worker', provider: 'codex', model: 'gpt-5.6', status: 'queued', createdAt: now + 3 }
    ]
  }
  win.webContents.send('ev:agentsChanged', agents)
  win.webContents.send('ev:orchestrator', snapshot)
}
