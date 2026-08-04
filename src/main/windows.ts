/**
 * Window management: frameless main window (custom title bar per design),
 * pop-out windows for individual agent panes, and broadcast to all windows.
 */
import { app, BrowserWindow, screen, shell } from 'electron'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { is } from '@electron-toolkit/utils'
import { installEditContextMenu } from '@main/editMenu'
import { brandEnv } from '@main/env'
import { getSetting, setSetting } from '@main/config/store'
import { protectWebContents } from '@main/security/navigation'
import { initAttentionService } from '@main/attention/attentionService'
import { workspacePlaceName } from '@shared/workspaceNames'
import { agentDataTargetWindows } from '@main/agentDataFanout'
import { workspaceProfileSchema } from '@shared/profile'
import { computeTiles, snapRailPosition, type Rect } from '@main/tiling'

/** Pre-paint window color matching the renderer themes (cozy-organic.css ambient). */
function windowBackground(): string {
  return getSetting<string>('ui.theme') === 'dark' ? '#0e1013' : '#e2dbcb'
}
const WINDOW_ICON = join(__dirname, '../renderer/favicon.png')
const paneWindows = new Map<string, Set<BrowserWindow>>()
let mainWindow: BrowserWindow | null = null
let voiceWindow: BrowserWindow | null = null
let railWindow: BrowserWindow | null = null

/** Representative profile for headless ProfileEditor screenshots. */
const DEMO_PROFILE = workspaceProfileSchema.parse({
  id: 'demo',
  name: 'Demo',
  workingDir: 'C:\\git\\demo-app',
  orchestrator: { provider: 'claude', model: 'sonnet', effort: 'high', autoOpenSubwindows: true },
  agents: [
    { role: 'backend', provider: 'codex', model: '', count: 2, orchestrated: true, yolo: true },
    { role: 'frontend', provider: 'cursor', model: 'composer', count: 3, orchestrated: true, yolo: false }
  ],
  yoloDefault: false,
  planner: { mode: 'review', maxParallel: 4 },
  autoPr: {
    mode: 'draft-after-checks',
    strategy: 'aggregate',
    baseBranch: 'main',
    qualityGates: ['corepack pnpm lint', 'corepack pnpm test'],
    labels: [],
    reviewers: []
  }
})

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
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
    webSecurity: true
  }
}

function secureWindow(win: BrowserWindow): void {
  protectWebContents(win.webContents, {
    developmentUrl: process.env['ELECTRON_RENDERER_URL'],
    packagedRendererUrl: pathToFileURL(join(__dirname, '../renderer/index.html')).toString(),
    openExternal: (url) => shell.openExternal(url)
  })
}

export function createMainWindow(): BrowserWindow {
  if (brandEnv('UI_SMOKE')) {
    // The tiles-grid smoke asserts the tiles layout with an expanded left
    // sidebar. Seed the config so the fresh smoke profile skips the one-time
    // canvas-default migration (D1) and boots straight into tiles.
    setSetting('ui.canvasDefaultApplied', true)
    setSetting('ui.workspaceLayout', 'tiles')
  }
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 720,
    show: false,
    frame: false, // custom title bar (design: window controls in-app)
    autoHideMenuBar: true,
    backgroundColor: windowBackground(),
    icon: WINDOW_ICON,
    title: 'Vertragus',
    webPreferences: baseWebPreferences()
  })
  mainWindow = win
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null
  })
  installEditContextMenu(win)

  if (!brandEnv('UI_SMOKE')) {
    win.on('ready-to-show', () => win.show())
  }
  secureWindow(win)

  // Headless UI capture for verification/CI: VERTRAGUS_SCREENSHOT=<file.png>.
  // VERTRAGUS_DEMO_DAG=1 pushes demo agents + task graph through the real render path.
  const shotPath = brandEnv('SCREENSHOT')
  if (shotPath) {
    win.webContents.once('did-finish-load', () => {
      if (brandEnv('DEMO_DAG')) {
        setTimeout(() => pushDemoState(win), 2500)
      }
      if (brandEnv('DEMO_EDITOR')) {
        setTimeout(() => {
          void win.webContents.executeJavaScript(`window.__vertragus && window.__vertragus.openEditor(${JSON.stringify(DEMO_PROFILE)})`)
        }, 2500)
      }
      if (brandEnv('DEMO_ADD_AGENT')) {
        setTimeout(() => {
          void win.webContents.executeJavaScript('window.__vertragus && window.__vertragus.openAddAgent()')
        }, 2500)
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

  const smokePath = brandEnv('UI_SMOKE')
  if (smokePath) {
    win.webContents.once('did-finish-load', () => {
      void (async () => {
        try {
          await win.webContents.executeJavaScript(`new Promise((resolve, reject) => {
            const deadline = Date.now() + 10000
            const waitForReady = () => {
              const ready = window.__vertragus?.ready
              if (ready) {
                Promise.resolve(ready).then(resolve, reject)
                return
              }
              if (Date.now() >= deadline) {
                reject(new Error('Renderer initialization timed out.'))
                return
              }
              setTimeout(waitForReady, 25)
            }
            waitForReady()
          })`)

          // The smoke checks assert the authored German labels; force de.
          await win.webContents.executeJavaScript(
            "window.__setAppLanguage ? window.__setAppLanguage('de') : Promise.resolve()"
          )
          pushDemoState(win)
          win.setSize(900, 800)
          await new Promise((resolve) => setTimeout(resolve, 250))

          const checks = await win.webContents.executeJavaScript(`(async () => {
            const gitTreeTrigger = document.querySelector('.git-tree-trigger')
            gitTreeTrigger?.click()
            await new Promise((resolve) => requestAnimationFrame(resolve))
            const gitTreePopover = document.querySelector('.git-tree-popover')
            const titlebarBottom = document.querySelector('.titlebar')?.getBoundingClientRect().bottom ?? 0
            const popoverRect = gitTreePopover?.getBoundingClientRect()
            const appRoot = document.querySelector('.app-root')
            const workspace = document.querySelector('.workspace')
            const grid = document.querySelector('.ws-grid')
            const pane = document.querySelector('.pane')
            const leftResizeHandle = document.querySelector(
              '[role="separator"][aria-label="Breite der linken Seitenleiste ändern"]'
            )
            const rightResizeHandle = document.querySelector(
              '[role="separator"][aria-label="Breite der Orchestrator-Seitenleiste ändern"]'
            )
            const workspaceWidthBeforeCollapse = workspace?.getBoundingClientRect().width ?? 0
            const paneWidthBeforeCollapse = pane?.getBoundingClientRect().width ?? 0
            const columnsBeforeCollapse = grid
              ? getComputedStyle(grid).gridTemplateColumns.split(' ').length
              : 0
            const hasNeedsWork = [...document.querySelectorAll('.task-pill')]
              .some((node) => node.textContent?.includes('Nacharbeit'))
            const hasGateFindings = Boolean(document.querySelector('.task-findings'))
            const hasPreflight = [...document.querySelectorAll('.task-review dd')]
              .some((node) => node.textContent?.includes('bestanden'))
            const hasReliability = Boolean(document.querySelector('.reliability-strip'))
            const hasAutoMode = (() => {
              const modeSwitch = document.querySelector('.planner-mode-switch')
              if (!modeSwitch) return false
              const options = [...modeSwitch.querySelectorAll('.planner-mode-opt')]
              const activeOptions = options.filter(
                (node) => node.getAttribute('aria-pressed') === 'true'
              )
              return options.length === 3 &&
                activeOptions.length === 1 &&
                ['Auto', 'Review', 'Manuell'].every((label) =>
                  options.some((node) => node.textContent?.trim() === label))
            })()

            leftResizeHandle?.dispatchEvent(
              new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })
            )
            await new Promise((resolve) => requestAnimationFrame(resolve))
            const keyboardWidth = JSON.parse(localStorage.getItem('vertragus.layout.v1') ?? '{}')
              .panels?.['sidebar-left']?.width

            leftResizeHandle?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
            await new Promise((resolve) => requestAnimationFrame(resolve))
            const resetWidth = JSON.parse(localStorage.getItem('vertragus.layout.v1') ?? '{}')
              .panels?.['sidebar-left']?.width

            document.querySelector('[aria-label="Linke Seitenleiste einklappen"]')?.click()
            document.querySelector('[aria-label="Orchestrator-Seitenleiste einklappen"]')?.click()
            await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))

            const workspaceWidthAfterCollapse = workspace?.getBoundingClientRect().width ?? 0
            const paneWidthAfterCollapse = pane?.getBoundingClientRect().width ?? 0
            const columnsAfterCollapse = grid
              ? getComputedStyle(grid).gridTemplateColumns.split(' ').length
              : 0
            const remainingResizeHandles = document.querySelectorAll(
              '[role="separator"][aria-orientation="vertical"]'
            )

            return {
              preload: typeof window.vertragus === 'object',
              sidebar: Boolean(document.querySelector('.sidebar')),
              workspace: Boolean(document.querySelector('.workspace')),
              titlebar: Boolean(document.querySelector('.titlebar')),
              gitTreePopover: Boolean(
                gitTreePopover &&
                // Portalled into .app-root (not the clipping anchor) so the
                // design tokens and data-theme apply; see useAppRootPortalTarget.
                gitTreePopover.parentElement === appRoot &&
                popoverRect &&
                popoverRect.height > 0 &&
                popoverRect.bottom > titlebarBottom
              ),
              language: document.documentElement.lang === 'de',
              csp: Boolean(document.querySelector('meta[http-equiv="Content-Security-Policy"]')),
              needsWork: hasNeedsWork,
              gateFindings: hasGateFindings,
              preflight: hasPreflight,
              reliability: hasReliability,
              responsive900: Boolean(
                appRoot &&
                appRoot.clientWidth <= 900 &&
                appRoot.scrollWidth <= appRoot.clientWidth &&
                workspaceWidthBeforeCollapse >= 200
              ),
              resizablePanels: Boolean(
                leftResizeHandle &&
                rightResizeHandle &&
                leftResizeHandle.getAttribute('aria-valuemin') === '200' &&
                rightResizeHandle.getAttribute('aria-valuemax') === '560'
              ),
              keyboardResize: keyboardWidth === 316,
              doubleClickReset: resetWidth === 300,
              collapsiblePanels: Boolean(
                document.querySelector('[aria-label="Linke Seitenleiste ausklappen"]') &&
                document.querySelector('[aria-label="Orchestrator-Seitenleiste ausklappen"]') &&
                remainingResizeHandles.length === 0
              ),
              workspaceFreed: workspaceWidthAfterCollapse > workspaceWidthBeforeCollapse + 400,
              dynamicGrid: columnsBeforeCollapse === 1 && columnsAfterCollapse >= 2,
              responsivePanes: Boolean(
                paneWidthBeforeCollapse > 0 && paneWidthAfterCollapse > paneWidthBeforeCollapse
              ),
              autoMode: hasAutoMode
            }
          })()`)
          const ok = Object.values(checks).every(Boolean)
          writeFileSync(
            smokePath,
            JSON.stringify({ ok, checks, capturedAt: new Date().toISOString() }, null, 2)
          )
          app.exit(ok ? 0 : 1)
        } catch (error) {
          writeFileSync(
            smokePath,
            JSON.stringify({
              ok: false,
              checks: {},
              error: error instanceof Error ? error.message : String(error),
              capturedAt: new Date().toISOString()
            }, null, 2)
          )
          app.exit(1)
        }
      })()
    })
  }
  loadRoute(win, '/')
  // Re-bind on every create (including macOS activate recreate).
  initAttentionService({ getMainWindow: () => mainWindow })
  return win
}

/** Only the main application window may invoke privileged workspace mutations. */
export function isMainWindowSender(sender: Electron.WebContents): boolean {
  return Boolean(mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents === sender)
}

/**
 * The frameless voice overlay window. It shares the renderer preload but is
 * deliberately denied every privileged agent/spawn/orchestrator channel: its
 * only sanctioned path to act on the workspace is `voiceAssistant:turn`, whose
 * bounded tool loop runs entirely in the main process. See the IPC hardening in
 * `ipc/register.ts` (`assertNotVoiceWindow`).
 */
export function isVoiceWindowSender(sender: Electron.WebContents): boolean {
  return Boolean(voiceWindow && !voiceWindow.isDestroyed() && voiceWindow.webContents === sender)
}

function createVoiceWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 380,
    height: 560,
    minWidth: 320,
    minHeight: 420,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    backgroundColor: '#00000000',
    icon: WINDOW_ICON,
    title: 'Vertragus — Voice',
    webPreferences: baseWebPreferences()
  })
  voiceWindow = win
  win.setAlwaysOnTop(true, 'floating')
  win.on('closed', () => {
    if (voiceWindow === win) voiceWindow = null
  })
  installEditContextMenu(win)
  secureWindow(win)
  win.on('ready-to-show', () => {
    win.showInactive()
    win.focus()
  })
  loadRoute(win, '/voice')
  return win
}

/** Show the overlay (creating it on first use), or hide it if already visible. */
export function toggleVoiceOverlay(): void {
  if (voiceWindow && !voiceWindow.isDestroyed()) {
    if (voiceWindow.isVisible()) {
      voiceWindow.hide()
    } else {
      voiceWindow.show()
      voiceWindow.focus()
    }
    return
  }
  createVoiceWindow()
}

/** Hide the overlay window without destroying it (self-hide from the overlay). */
export function hideVoiceOverlay(): void {
  if (voiceWindow && !voiceWindow.isDestroyed() && voiceWindow.isVisible()) {
    voiceWindow.hide()
  }
}

/** Persist the overlay window position after a native drag from the overlay. */
export function moveVoiceOverlay(x: number, y: number): void {
  if (!voiceWindow || voiceWindow.isDestroyed()) return
  if (!Number.isFinite(x) || !Number.isFinite(y)) return
  voiceWindow.setPosition(Math.round(x), Math.round(y))
}

// ---------------------------------------------------------------------------
// Desktop-Rail: schmale Always-on-top-Startleiste (#/sidebar)
// ---------------------------------------------------------------------------

const RAIL_WIDTH = 280
const RAIL_MAX_HEIGHT = 680
const RAIL_MARGIN = 12
/** Persistierte Rail-Lage: Kante + vertikale Position. */
interface RailBounds {
  edge: 'left' | 'right'
  y: number
}

function parseRailBounds(value: unknown): RailBounds | undefined {
  if (!value || typeof value !== 'object') return undefined
  const record = value as { edge?: unknown; y?: unknown }
  if (record.edge !== 'left' && record.edge !== 'right') return undefined
  if (typeof record.y !== 'number' || !Number.isFinite(record.y)) return undefined
  return { edge: record.edge, y: record.y }
}

function railGeometry(): { x: number; y: number; width: number; height: number } {
  const workArea = screen.getPrimaryDisplay().workArea
  const height = Math.min(RAIL_MAX_HEIGHT, workArea.height - 2 * RAIL_MARGIN)
  const stored = parseRailBounds(getSetting('ui.railBounds'))
  const edge = stored?.edge ?? 'right'
  const x = edge === 'left'
    ? workArea.x + RAIL_MARGIN
    : workArea.x + workArea.width - RAIL_WIDTH - RAIL_MARGIN
  const y = Math.min(
    Math.max(stored?.y ?? workArea.y + RAIL_MARGIN, workArea.y),
    workArea.y + Math.max(0, workArea.height - height)
  )
  return { x, y, width: RAIL_WIDTH, height }
}

/** Nur das Rail-Fenster darf rail:moved senden; rail:openMain zusätzlich das Hauptfenster. */
export function isRailWindowSender(sender: Electron.WebContents): boolean {
  return Boolean(railWindow && !railWindow.isDestroyed() && railWindow.webContents === sender)
}

/** True für jedes Agent-Pane-Popout-Fenster (Read-Pfade wie Session-Listen). */
export function isPaneWindowSender(sender: Electron.WebContents): boolean {
  for (const windows of paneWindows.values()) {
    for (const win of windows) {
      if (!win.isDestroyed() && win.webContents === sender) return true
    }
  }
  return false
}

export function createRailWindow(): BrowserWindow {
  if (railWindow && !railWindow.isDestroyed()) {
    railWindow.show()
    railWindow.focus()
    return railWindow
  }
  const geometry = railGeometry()
  const win = new BrowserWindow({
    ...geometry,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    // Im Rail-Startmodus ist die Rail die einzige Oberfläche der App — sie
    // muss über die Taskleiste erreichbar bleiben (anders als das Voice-Overlay).
    skipTaskbar: false,
    alwaysOnTop: true,
    backgroundColor: '#00000000',
    icon: WINDOW_ICON,
    title: 'Vertragus — Rail',
    webPreferences: baseWebPreferences()
  })
  railWindow = win
  win.setAlwaysOnTop(true, 'floating')
  win.on('closed', () => {
    if (railWindow === win) railWindow = null
  })
  // Kanten-Snap + Persistenz nach jeder Positionsänderung. Bewusst das
  // entprellte 'move'-Event statt 'moved': Letzteres feuert unter Windows nur
  // am Ende eines NUTZER-Drags (WM_EXITSIZEMOVE), nicht bei programmatischen
  // Moves. Das Entprellen (200 ms Ruhe) markiert das Drag-Ende; der Snap einer
  // bereits gesnappten Position ist Identität, es entsteht keine Schleife.
  let railMoveTimer: NodeJS.Timeout | undefined
  win.on('move', () => {
    if (railMoveTimer) clearTimeout(railMoveTimer)
    railMoveTimer = setTimeout(() => snapAndPersistRail(win), 200)
  })
  win.on('closed', () => {
    if (railMoveTimer) clearTimeout(railMoveTimer)
  })
  installEditContextMenu(win)
  secureWindow(win)
  win.on('ready-to-show', () => win.show())

  // Headless-Verifikation der Rail (scripts/rail-smoke.mjs):
  // VERTRAGUS_RAIL_SCREENSHOT=<file.png> captured das Fenster nach dem Boot.
  const railShotPath = brandEnv('RAIL_SCREENSHOT')
  if (railShotPath) {
    win.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        try {
          const image = await win.webContents.capturePage()
          writeFileSync(railShotPath, image.toPNG())
        } finally {
          app.quit()
        }
      }, 4000)
    })
  }

  loadRoute(win, '/sidebar')
  return win
}

/** Show the rail (creating it on first use), or hide it if already visible. */
export function toggleRailWindow(): void {
  if (railWindow && !railWindow.isDestroyed()) {
    if (railWindow.isVisible()) {
      railWindow.hide()
    } else {
      railWindow.show()
      railWindow.focus()
    }
    return
  }
  createRailWindow()
}

/** Rail-Kante + Breite für die Kachelung; null, wenn keine sichtbare Rail existiert. */
export function getRailDock(): { edge: 'left' | 'right'; width: number } | null {
  if (!railWindow || railWindow.isDestroyed() || !railWindow.isVisible()) return null
  const workArea = screen.getPrimaryDisplay().workArea
  const [x] = railWindow.getPosition()
  const center = x + RAIL_WIDTH / 2
  const edge = center < workArea.x + workArea.width / 2 ? 'left' : 'right'
  return { edge, width: RAIL_WIDTH + RAIL_MARGIN }
}

/**
 * Nach einem nativen OS-Drag (-webkit-app-region: drag im Renderer): an die
 * Bildschirmkante snappen, y klemmen und die Lage persistieren. Das
 * 'moved'-Event feuert am Drag-Ende — kein Debounce/IPC nötig.
 */
function snapAndPersistRail(win: BrowserWindow): void {
  if (win.isDestroyed()) return
  const workArea = screen.getDisplayMatching(win.getBounds()).workArea
  const inset: Rect = {
    x: workArea.x + RAIL_MARGIN,
    y: workArea.y + RAIL_MARGIN,
    width: workArea.width - 2 * RAIL_MARGIN,
    height: workArea.height - 2 * RAIL_MARGIN
  }
  const bounds = win.getBounds()
  const snapped = snapRailPosition(bounds.x, bounds.y, inset, RAIL_WIDTH, bounds.height)
  if (snapped.x !== bounds.x || snapped.y !== bounds.y) {
    win.setPosition(snapped.x, snapped.y)
  }
  const center = snapped.x + RAIL_WIDTH / 2
  const edge = center < workArea.x + workArea.width / 2 ? 'left' : 'right'
  setSetting('ui.railBounds', { edge, y: snapped.y })
}

/** "Full"-Button der Rail: Hauptfenster fokussieren oder neu erzeugen. */
export function openMainWindow(): BrowserWindow {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
    return mainWindow
  }
  return createMainWindow()
}

/**
 * Rail-Start: alle Agenten (inkl. Orchestrator) als eigene Pane-Fenster über
 * die freie Arbeitsfläche kacheln. Vorhandene Panes werden nur umpositioniert.
 */
export function tileAgentWindows(agentIds: string[], primaryIndex: number): void {
  if (agentIds.length === 0) return
  const workArea = screen.getPrimaryDisplay().workArea
  const dock = getRailDock()
  const tiles = computeTiles({
    workArea,
    railEdge: dock?.edge,
    railWidth: dock?.width ?? 0,
    count: agentIds.length,
    primaryIndex
  })
  agentIds.forEach((agentId, index) => {
    const tile = tiles[index]
    if (tile) showTiledPaneWindow(agentId, tile)
  })
}

/** Vorhandenes Pane-Fenster auf die Kachel setzen + fokussieren, sonst neu erzeugen. */
export function showTiledPaneWindow(agentId: string, tile: Rect): BrowserWindow {
  const existing = paneWindows.get(agentId)
  for (const win of existing ?? []) {
    if (!win.isDestroyed()) {
      win.setBounds(tile)
      win.focus()
      return win
    }
  }
  return createPaneWindow(agentId, tile)
}

/** Pop out a single agent pane into its own OS window (native frame). */
export function createPaneWindow(agentId: string, bounds?: Rect): BrowserWindow {
  const win = new BrowserWindow({
    width: bounds?.width ?? 760,
    height: bounds?.height ?? 520,
    ...(bounds ? { x: bounds.x, y: bounds.y } : {}),
    minWidth: 420,
    minHeight: 300,
    autoHideMenuBar: true,
    backgroundColor: windowBackground(),
    icon: WINDOW_ICON,
    title: `Vertragus — ${agentId}`,
    webPreferences: baseWebPreferences()
  })
  installEditContextMenu(win)
  secureWindow(win)
  let windows = paneWindows.get(agentId)
  if (!windows) {
    windows = new Set()
    paneWindows.set(agentId, windows)
  }
  windows.add(win)
  win.on('closed', () => {
    windows?.delete(win)
    if (windows?.size === 0) paneWindows.delete(agentId)
  })
  loadRoute(win, `/pane/${agentId}`)
  return win
}

/** Close every native pop-out that displays the given agent pane. */
export function closePaneWindows(agentId: string): void {
  const windows = paneWindows.get(agentId)
  if (!windows) return
  paneWindows.delete(agentId)
  for (const win of windows) {
    if (!win.isDestroyed()) win.close()
  }
}

export function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload)
  }
}

/**
 * Send one agent's PTY chunk only to the windows that render its terminal —
 * the main window plus that agent's pop-out pane(s) — instead of broadcasting
 * to every window (Audit A6). Target selection lives in agentDataFanout.ts.
 */
export function broadcastAgentData(channel: string, agentId: string, payload: unknown): void {
  for (const win of agentDataTargetWindows(agentId, mainWindow, paneWindows)) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload)
  }
}

/** Dev/CI only: feed representative Phase-2 state through the normal push channels. */
export function pushDemoState(win: BrowserWindow): void {
  const profileId = 'default'
  const workspaceSessionId = 'session-demo'
  const now = Date.now()
  const agents = [
    { id: 'orch-01', name: 'Boromir', provider: 'claude', model: 'sonnet', role: 'Orchestrator · plant & verteilt', kind: 'orchestrator', mode: 'interactive', yolo: false, workingDir: '~/repos/checkout', status: 'running', startedAt: now },
    { id: 'task-02', name: 'Caronte', provider: 'codex', model: 'gpt-5.6', role: 'Task · worker', kind: 'sub', mode: 'task', taskId: 't-1', yolo: false, workingDir: '.', worktree: '.', status: 'running', startedAt: now },
    { id: 'task-03', name: 'Nesso', provider: 'codex', model: 'gpt-5.6', role: 'Task · worker', kind: 'sub', mode: 'task', taskId: 't-2', yolo: true, workingDir: '.', worktree: '.', status: 'running', startedAt: now },
    { id: 'task-04', name: 'Ulisse', provider: 'codex', model: 'gpt-5.6', role: 'Task · worker', kind: 'sub', mode: 'task', taskId: 't-3', yolo: false, workingDir: '.', status: 'stopped', startedAt: now }
  ].map((agent) => ({ ...agent, profileId, workspaceSessionId, engineId: 'engine-demo' }))
  const snapshot = {
    profileId,
    workspaceSessionId,
    plannerMode: 'review',
    engineId: 'engine-demo',
    goal: { id: 'epic-4471', title: 'Checkout-Flow v2', active: true },
    reliability: {
      dispatchAttempts: 4,
      preflightPassed: 3,
      preflightFailed: 1,
      infrastructureFailures: 1,
      automaticRecoveries: 1,
      needsWorkTasks: 1,
      rescuedNeedsWorkCommits: 1,
      completedPlans: 1,
      preventedFalseSuccesses: 1,
      lastSnapshotAt: now,
      maxRunningStatusAgeMs: 42000,
      failuresByProviderAndPlatform: { 'cursor:win32': 1 }
    },
    tasks: [
      { id: 't-1', title: 'API · POST /checkout', role: 'worker', agentId: 'task-02', agentName: 'Caronte', provider: 'codex', model: 'gpt-5.6', status: 'running', createdAt: now },
      { id: 't-2', title: 'E2E · Checkout-Spec', role: 'worker', agentId: 'task-03', agentName: 'Nesso', provider: 'codex', model: 'gpt-5.6', status: 'running', yolo: true, createdAt: now + 1 },
      {
        id: 't-3', title: 'DB · Migration', role: 'worker', agentId: 'task-04', agentName: 'Ulisse',
        provider: 'codex', model: 'gpt-5.6', status: 'needs-work', criticality: 'required',
        phase: 'security-review', commit: 'abcdef0123456789',
        note: 'Partieller Commit gesichert; ein Security-Negativtest fehlt.',
        findings: [{ gate: 'security', code: 'missing-filesystem-controls', message: 'path-traversal', files: ['src/main/files/migrate.ts'] }],
        preflight: {
          status: 'passed', provider: 'codex', workspaceId: 'demo', engineId: 'engine-demo',
          startedAt: now - 2000, completedAt: now - 1800,
          checks: [{ id: 'workspace', status: 'passed', detail: 'Workspace schreibbar', durationMs: 2 }]
        },
        attempts: [{ attempt: 1, agentId: 'task-04', agentName: 'Ulisse', provider: 'codex', model: 'gpt-5.6', status: 'needs-work', startedAt: now - 5000, finishedAt: now - 1000 }],
        createdAt: now + 2, finishedAt: now + 3
      },
      { id: 't-4', title: 'Review · PR #482', role: 'worker', provider: 'codex', model: 'gpt-5.6', status: 'queued', criticality: 'advisory', createdAt: now + 3 }
    ]
  }
  win.webContents.send('ev:workspaceSessions', [{
    id: workspaceSessionId,
    profileId,
    profileName: 'UI Smoke',
    sequence: 1,
    name: workspacePlaceName(1),
    startedAt: now,
    active: true
  }])
  win.webContents.send('ev:agentsChanged', agents)
  win.webContents.send('ev:orchestrator', snapshot)
}
