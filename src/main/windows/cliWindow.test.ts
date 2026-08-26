import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The CLI window registry is the authorization root of the terminal IPC, so it
 * is tested without Electron: a fake BrowserWindow gives us the two properties
 * that matter — the webContents ↔ agent mapping and the window options.
 */
const listeners = new Map<FakeBrowserWindow, Map<string, () => void>>()
let nextWebContentsId = 1

const settingsUi = vi.hoisted(() => ({
  startMinimized: false,
  cliWindowMode: 'per-agent' as 'per-agent' | 'tabs'
}))

class FakeWebContentsView {
  static instances: FakeWebContentsView[] = []
  readonly webContents = {
    id: nextWebContentsId++,
    isDestroyed: (): boolean => false,
    send: vi.fn(),
    close: vi.fn()
  }
  bounds = { x: 0, y: 0, width: 0, height: 0 }
  visible = true

  constructor(_options?: Record<string, unknown>) {
    FakeWebContentsView.instances.push(this)
  }
  setBounds(bounds: { x: number; y: number; width: number; height: number }): void {
    this.bounds = bounds
  }
  setVisible(visible: boolean): void {
    this.visible = visible
  }
  getVisible(): boolean {
    return this.visible
  }
  getBounds(): { x: number; y: number; width: number; height: number } {
    return this.bounds
  }
}

class FakeBrowserWindow {
  static instances: FakeBrowserWindow[] = []
  readonly webContents = {
    id: nextWebContentsId++,
    isDestroyed: (): boolean => false,
    send: vi.fn(),
    close: vi.fn()
  }
  destroyed = false
  shown = false
  focused = false
  minimized = false
  readonly childViews: FakeWebContentsView[] = []
  readonly contentView = {
    addChildView: (view: FakeWebContentsView): void => {
      this.childViews.push(view)
    },
    removeChildView: (view: FakeWebContentsView): void => {
      const index = this.childViews.indexOf(view)
      if (index >= 0) this.childViews.splice(index, 1)
    }
  }
  /** Which of show / showInactive / focus ran, in order. */
  readonly calls: Array<'show' | 'showInactive' | 'focus' | 'minimize' | 'restore'> = []

  constructor(public readonly options: Record<string, unknown>) {
    FakeBrowserWindow.instances.push(this)
    listeners.set(this, new Map())
  }

  on(event: string, handler: () => void): this {
    listeners.get(this)!.set(event, handler)
    return this
  }
  emit(event: string): void {
    listeners.get(this)?.get(event)?.()
  }
  isDestroyed(): boolean {
    return this.destroyed
  }
  isMinimized(): boolean {
    return this.minimized
  }
  getBounds(): { x: number; y: number; width: number; height: number } {
    return {
      x: (this.options.x as number) ?? 0,
      y: (this.options.y as number) ?? 0,
      width: (this.options.width as number) ?? 0,
      height: (this.options.height as number) ?? 0
    }
  }
  setBounds(bounds: { x: number; y: number; width: number; height: number }): void {
    this.options.x = bounds.x
    this.options.y = bounds.y
    this.options.width = bounds.width
    this.options.height = bounds.height
  }
  isFocused(): boolean {
    return this.focused
  }
  restore(): void {
    this.minimized = false
    this.calls.push('restore')
  }
  minimize(): void {
    this.minimized = true
    this.calls.push('minimize')
  }
  hide(): void {
    this.shown = false
  }
  isVisible(): boolean {
    return this.shown && !this.destroyed
  }
  getContentBounds(): { x: number; y: number; width: number; height: number } {
    return this.getBounds()
  }
  setTitle(_title: string): void {}
  show(): void {
    this.shown = true
    this.calls.push('show')
  }
  showInactive(): void {
    this.shown = true
    this.calls.push('showInactive')
  }
  focus(): void {
    this.focused = true
    this.calls.push('focus')
  }
  close(): void {
    this.destroyed = true
    this.emit('closed')
  }
}

function fake(win: unknown): FakeBrowserWindow {
  return win as unknown as FakeBrowserWindow
}

const META = { title: 'Caronte', roleColor: '#2f7d6d' } as const

vi.mock('electron', () => ({
  BrowserWindow: FakeBrowserWindow,
  WebContentsView: FakeWebContentsView,
  ipcMain: { handle: vi.fn(), on: vi.fn(), removeHandler: vi.fn(), removeAllListeners: vi.fn() }
}))
vi.mock('@main/store/settings', () => ({
  getSettings: () => ({ ui: settingsUi })
}))

const loadRoute = vi.fn()
const loadContentsRoute = vi.fn()
const secureWindow = vi.fn()
const secureWebContents = vi.fn()
vi.mock('./base', () => ({
  glassWindowOptions: () => ({ frame: false, transparent: true }),
  baseWebPreferences: () => ({ sandbox: true }),
  loadRoute: (...args: unknown[]) => loadRoute(...args),
  loadContentsRoute: (...args: unknown[]) => loadContentsRoute(...args),
  secureWindow: (...args: unknown[]) => secureWindow(...args),
  secureWebContents: (...args: unknown[]) => secureWebContents(...args)
}))

class FakePanel {
  focused = false
  destroyed = false
  readonly calls: Array<'focus'> = []
  isDestroyed(): boolean {
    return this.destroyed
  }
  isFocused(): boolean {
    return this.focused
  }
  focus(): void {
    this.focused = true
    this.calls.push('focus')
  }
}

const panelControl = vi.hoisted(() => ({
  current: null as {
    focused: boolean
    destroyed: boolean
    readonly calls: Array<'focus'>
    isDestroyed(): boolean
    isFocused(): boolean
    focus(): void
  } | null
}))

vi.mock('./panel', () => ({
  getPanelWindow: () => panelControl.current
}))

type CliWindowModule = typeof import('./cliWindow')
let cli: CliWindowModule

beforeEach(async () => {
  vi.resetModules()
  vi.clearAllMocks()
  FakeBrowserWindow.instances = []
  FakeWebContentsView.instances = []
  listeners.clear()
  panelControl.current = null
  settingsUi.startMinimized = false
  settingsUi.cliWindowMode = 'per-agent'
  nextWebContentsId = 1
  cli = await import('./cliWindow')
})

function focusedPanel(): FakePanel {
  const panel = new FakePanel()
  panel.focused = true
  panelControl.current = panel
  return panel
}

describe('createCliWindow', () => {
  it('creates a frameless, resizable glass window that is never always-on-top', () => {
    cli.createCliWindow('agent-1', { title: 'Caronte', roleColor: '#2f7d6d' })
    const options = FakeBrowserWindow.instances[0]!.options

    expect(options.frame).toBe(false)
    expect(options.transparent).toBe(true)
    expect(options.resizable).toBe(true)
    expect(options.alwaysOnTop).toBe(false)
    // Grow/shrink is the title bar's, not the OS's — see createCliWindow.
    expect(options.maximizable).toBe(false)
    expect(options.minWidth).toBe(cli.CLI_MIN_WIDTH)
    expect(options.minHeight).toBe(cli.CLI_MIN_HEIGHT)
    expect(options.title).toBe('Vertragus — Caronte')
  })

  it('loads the agent route and applies the navigation guard', () => {
    const win = cli.createCliWindow('agent 1/x', { title: 'Caronte', roleColor: '#2f7d6d' })
    expect(secureWindow).toHaveBeenCalledWith(win)
    expect(loadRoute).toHaveBeenCalledWith(win, `/agent/${encodeURIComponent('agent 1/x')}`)
  })

  it('honours explicit bounds and falls back to the default size', () => {
    cli.createCliWindow('a', { title: 'A', roleColor: '#000', bounds: { x: 40, y: 60, width: 900 } })
    const options = FakeBrowserWindow.instances[0]!.options
    expect(options).toMatchObject({ x: 40, y: 60, width: 900 })
    expect(options.height).toBe(cli.CLI_DEFAULT_HEIGHT)

    cli.createCliWindow('b', { title: 'B', roleColor: '#000' })
    const second = FakeBrowserWindow.instances[1]!.options
    expect(second.width).toBe(cli.CLI_DEFAULT_WIDTH)
    expect(second.x).toBeUndefined()
  })

  it('reuses an existing window without stealing focus when nothing in the app is focused', () => {
    const first = fake(cli.createCliWindow('agent-1', META))
    const again = cli.createCliWindow('agent-1', META)
    expect(again).toBe(first)
    expect(FakeBrowserWindow.instances).toHaveLength(1)
    expect(first.calls).toEqual(['showInactive'])
    expect(first.focused).toBe(false)
  })

  it('reuses the first CLI with show+focus when the panel is focused (Play)', () => {
    focusedPanel()
    const first = fake(cli.createCliWindow('agent-1', META))
    const again = cli.createCliWindow('agent-1', META)
    expect(again).toBe(first)
    expect(first.calls).toEqual(['show', 'focus'])
    expect(first.focused).toBe(true)
  })

  it('shows a new window inactive when nothing in the app is focused', () => {
    const win = fake(cli.createCliWindow('agent-1', META))
    win.emit('ready-to-show')
    expect(win.calls).toEqual(['showInactive'])
    expect(win.focused).toBe(false)
  })

  it('shows the first CLI when the panel is focused (Play)', () => {
    const panel = focusedPanel()
    const win = fake(cli.createCliWindow('agent-1', META))
    win.emit('ready-to-show')
    expect(win.calls).toEqual(['show'])
    expect(panel.calls).toEqual([])
  })

  it('shows a new window inactive when another CLI is focused', () => {
    const other = fake(cli.createCliWindow('agent-a', { title: 'A', roleColor: '#111' }))
    other.focused = true
    const win = fake(cli.createCliWindow('agent-b', { title: 'B', roleColor: '#222' }))
    win.emit('ready-to-show')
    expect(win.calls).toEqual(['showInactive'])
    expect(win.focused).toBe(false)
    expect(other.calls).toContain('focus')
    expect(other.focused).toBe(true)
  })

  it('shows inactive on ready-to-show even if construction stole focus from the other CLI', () => {
    const other = fake(cli.createCliWindow('agent-a', { title: 'A', roleColor: '#111' }))
    other.focused = true
    const win = fake(cli.createCliWindow('agent-b', { title: 'B', roleColor: '#222' }))
    other.focused = false
    win.emit('ready-to-show')
    expect(win.calls).toEqual(['showInactive'])
    expect(win.focused).toBe(false)
    expect(other.calls).toContain('focus')
    expect(other.focused).toBe(true)
  })

  it('restores panel focus when spawning while the panel is focused and a CLI already exists', () => {
    const panel = focusedPanel()
    fake(cli.createCliWindow('agent-a', { title: 'A', roleColor: '#111' }))
    panel.focused = true
    const win = fake(cli.createCliWindow('agent-b', { title: 'B', roleColor: '#222' }))
    panel.focused = false
    win.emit('ready-to-show')
    expect(win.calls).toEqual(['showInactive'])
    expect(win.focused).toBe(false)
    expect(panel.calls).toContain('focus')
    expect(panel.focused).toBe(true)
  })

  it('reuses an existing window without stealing focus from another CLI', () => {
    const other = fake(cli.createCliWindow('agent-a', { title: 'A', roleColor: '#111' }))
    other.focused = true
    const existing = fake(cli.createCliWindow('agent-b', { title: 'B', roleColor: '#222' }))
    const again = cli.createCliWindow('agent-b', { title: 'B', roleColor: '#222' })
    expect(again).toBe(existing)
    expect(FakeBrowserWindow.instances).toHaveLength(2)
    expect(existing.calls).toEqual(['showInactive'])
    expect(existing.focused).toBe(false)
    expect(other.calls).toContain('focus')
    expect(other.focused).toBe(true)
  })

  it('reuses an existing window without stealing when the panel is focused and other CLIs exist', () => {
    const panel = focusedPanel()
    fake(cli.createCliWindow('agent-a', { title: 'A', roleColor: '#111' }))
    panel.focused = true
    const existing = fake(cli.createCliWindow('agent-b', { title: 'B', roleColor: '#222' }))
    panel.focused = true
    const again = cli.createCliWindow('agent-b', { title: 'B', roleColor: '#222' })
    expect(again).toBe(existing)
    expect(existing.calls).toEqual(['showInactive'])
    expect(existing.focused).toBe(false)
    expect(panel.calls).toContain('focus')
    expect(panel.focused).toBe(true)
  })
})

describe('CLI window registry', () => {
  it('maps a webContents id to exactly one agent and rejects everything else', () => {
    const a = cli.createCliWindow('agent-a', { title: 'A', roleColor: '#111' })
    const b = cli.createCliWindow('agent-b', { title: 'B', roleColor: '#222' })

    expect(cli.isCliWindowSender(a.webContents.id)).toBe('agent-a')
    expect(cli.isCliWindowSender(b.webContents.id)).toBe('agent-b')
    expect(cli.isCliWindowSender(9999)).toBeNull()
  })

  it('forgets a window once it is closed', () => {
    const win = cli.createCliWindow('agent-a', { title: 'A', roleColor: '#111' })
    const id = win.webContents.id
    expect(cli.listCliWindows().map((entry) => entry.agentId)).toEqual(['agent-a'])

    cli.closeCliWindow('agent-a')

    expect(cli.getCliWindow('agent-a')).toBeNull()
    expect(cli.listCliWindows()).toEqual([])
    expect(cli.isCliWindowSender(id)).toBeNull()
    expect((win as unknown as FakeBrowserWindow).destroyed).toBe(true)
  })

  it('prunes destroyed windows that never fired closed', () => {
    const win = cli.createCliWindow('agent-a', { title: 'A', roleColor: '#111' })
    ;(win as unknown as FakeBrowserWindow).destroyed = true

    expect(cli.getCliWindow('agent-a')).toBeNull()
    expect(cli.listCliWindows()).toEqual([])
  })

  it('notifies listeners when a window is closed', () => {
    const seen: string[] = []
    const off = cli.onCliWindowClosed((agentId) => seen.push(agentId))
    cli.createCliWindow('agent-a', { title: 'A', roleColor: '#111' })
    cli.closeCliWindow('agent-a')
    expect(seen).toEqual(['agent-a'])
    off()
    cli.createCliWindow('agent-b', { title: 'B', roleColor: '#222' })
    cli.closeCliWindow('agent-b')
    expect(seen).toEqual(['agent-a'])
  })

  it('focus restores a minimized window', () => {
    const win = fake(cli.createCliWindow('agent-a', { title: 'A', roleColor: '#111' }))
    win.minimized = true
    cli.focusCliWindow('agent-a')
    expect(win.minimized).toBe(false)
    expect(win.calls).toEqual(['restore', 'show', 'focus'])
    expect(win.focused).toBe(true)
    expect(() => cli.focusCliWindow('ghost')).not.toThrow()
  })

  it('focus restores, shows and focuses even when another CLI is focused', () => {
    const other = fake(cli.createCliWindow('agent-a', { title: 'A', roleColor: '#111' }))
    other.focused = true
    const win = fake(cli.createCliWindow('agent-b', { title: 'B', roleColor: '#222' }))
    win.minimized = true
    cli.focusCliWindow('agent-b')
    expect(win.minimized).toBe(false)
    expect(win.calls).toEqual(['restore', 'show', 'focus'])
    expect(win.focused).toBe(true)
  })

  it('minimizeCliWindow minimizes without forgetting the registry entry', () => {
    const win = cli.createCliWindow('agent-a', { title: 'A', roleColor: '#111' })

    cli.minimizeCliWindow('agent-a')

    expect((win as unknown as FakeBrowserWindow).minimized).toBe(true)
    expect(cli.getCliWindow('agent-a')).toBe(win)
    expect(cli.isCliWindowSender(win.webContents.id)).toBe('agent-a')
  })

  it('minimizing an unknown agent is a no-op', () => {
    expect(() => cli.minimizeCliWindow('ghost')).not.toThrow()
  })
})

describe('startMinimized', () => {
  it('minimizes after the first show when the pref is on', async () => {
    settingsUi.startMinimized = true
    const placement = await import('./placement')
    const suppress = vi.spyOn(placement, 'suppressMoveTracking')
    const win = fake(cli.createCliWindow('agent-a', META))
    win.emit('ready-to-show')
    expect(win.calls).toEqual(['show', 'minimize'])
    expect(win.minimized).toBe(true)
    expect(suppress).toHaveBeenCalledWith('agent-a')
  })

  it('does not minimize when the pref is off', () => {
    const win = fake(cli.createCliWindow('agent-a', META))
    win.emit('ready-to-show')
    expect(win.calls).toEqual(['show'])
    expect(win.minimized).toBe(false)
  })

  it('does not rewrite a live window when the pref flips on later', () => {
    const win = fake(cli.createCliWindow('agent-a', META))
    win.emit('ready-to-show')
    settingsUi.startMinimized = true
    expect(win.minimized).toBe(false)
    expect(win.calls).toEqual(['show'])
  })

  it('skips minimize when focusCliWindow ran before ready-to-show', () => {
    settingsUi.startMinimized = true
    const win = fake(cli.createCliWindow('agent-a', META))
    cli.focusCliWindow('agent-a')
    win.emit('ready-to-show')
    expect(win.minimized).toBe(false)
    expect(win.calls).not.toContain('minimize')
  })

  it('suppresses move tracking before restore even when the pref is off', async () => {
    const placement = await import('./placement')
    const suppress = vi.spyOn(placement, 'suppressMoveTracking')
    const win = fake(cli.createCliWindow('agent-a', META))
    win.minimized = true
    cli.focusCliWindow('agent-a')
    expect(suppress).toHaveBeenCalledWith('agent-a')
    expect(win.calls[0]).toBe('restore')
  })
})

describe('tabs mode', () => {
  const TAB = {
    title: 'Caronte',
    roleColor: '#2f7d6d',
    cliWindowMode: 'tabs' as const,
    placement: { roleId: 'orchestrator', workspaceId: 'ws-1' }
  }
  const TAB_B = {
    title: 'Arlecchino',
    roleColor: '#8c4a3a',
    cliWindowMode: 'tabs' as const,
    placement: { roleId: 'worker', workspaceId: 'ws-1' }
  }

  it('opens one chrome window and a view per agent', () => {
    const chrome = fake(cli.createCliWindow('orch', TAB))
    cli.createCliWindow('worker', TAB_B)
    expect(FakeBrowserWindow.instances).toHaveLength(1)
    expect(FakeWebContentsView.instances).toHaveLength(2)
    expect(loadRoute).toHaveBeenCalledWith(chrome, '/workspace/ws-1')
    expect(loadContentsRoute).toHaveBeenCalledWith(
      FakeWebContentsView.instances[0]!.webContents,
      '/agent/orch'
    )
    expect(loadContentsRoute).toHaveBeenCalledWith(
      FakeWebContentsView.instances[1]!.webContents,
      '/agent/worker'
    )
    expect(chrome.childViews).toHaveLength(2)
  })

  it('maps the view webContents, never the chrome window', () => {
    const chrome = cli.createCliWindow('orch', TAB)
    cli.createCliWindow('worker', TAB_B)
    expect(cli.isCliWindowSender(chrome.webContents.id)).toBeNull()
    expect(cli.isCliWindowSender(FakeWebContentsView.instances[0]!.webContents.id)).toBe('orch')
    expect(cli.isCliWindowSender(FakeWebContentsView.instances[1]!.webContents.id)).toBe('worker')
    expect(cli.isWorkspaceChromeSender(chrome.webContents.id)).toBe('ws-1')
    expect(cli.cliWebContents('orch')).toBe(FakeWebContentsView.instances[0]!.webContents)
    expect(cli.getCliWindow('orch')).toBe(chrome)
    expect(cli.getCliWindow('worker')).toBe(chrome)
  })

  it('selects a tab that belongs to this workspace and hides the other view', () => {
    cli.createCliWindow('orch', TAB)
    cli.createCliWindow('worker', TAB_B)
    const first = FakeWebContentsView.instances[0]!
    const second = FakeWebContentsView.instances[1]!
    expect(first.visible).toBe(true)
    expect(second.visible).toBe(false)

    expect(cli.selectCliTabInWorkspace('ws-1', 'worker')).toBe(true)
    expect(first.visible).toBe(false)
    expect(second.visible).toBe(true)

    expect(cli.selectCliTabInWorkspace('ws-1', 'foreign')).toBe(false)
    expect(cli.selectCliTabInWorkspace('other-ws', 'worker')).toBe(false)
    expect(second.visible).toBe(true)
  })

  it('closes one tab without destroying the parent while another remains', () => {
    const chrome = fake(cli.createCliWindow('orch', TAB))
    cli.createCliWindow('worker', TAB_B)
    cli.closeCliWindow('worker')
    expect(chrome.destroyed).toBe(false)
    expect(cli.getCliWindow('worker')).toBeNull()
    expect(cli.getCliWindow('orch')).toBe(chrome)
    expect(cli.isCliWindowSender(FakeWebContentsView.instances[1]!.webContents.id)).toBeNull()
  })

  it('closes the parent when the last tab is closed', () => {
    const chrome = fake(cli.createCliWindow('orch', TAB))
    cli.closeCliWindow('orch')
    expect(chrome.destroyed).toBe(true)
    expect(cli.getCliWindow('orch')).toBeNull()
  })

  it('minimizes the parent on first show when startMinimized is on', () => {
    settingsUi.startMinimized = true
    const chrome = fake(cli.createCliWindow('orch', TAB))
    chrome.emit('ready-to-show')
    expect(chrome.calls).toEqual(['show', 'minimize'])
    expect(chrome.minimized).toBe(true)
    cli.createCliWindow('worker', TAB_B)
    expect(chrome.minimized).toBe(true)
    expect(FakeBrowserWindow.instances).toHaveLength(1)
  })

  it('focusCliWindow restores the parent and selects that tab', () => {
    const chrome = fake(cli.createCliWindow('orch', TAB))
    cli.createCliWindow('worker', TAB_B)
    chrome.minimized = true
    cli.focusCliWindow('worker')
    expect(chrome.minimized).toBe(false)
    expect(chrome.calls).toEqual(['restore', 'show', 'focus'])
    expect(FakeWebContentsView.instances[1]!.visible).toBe(true)
    expect(FakeWebContentsView.instances[0]!.visible).toBe(false)
  })

  it('preload lists the cliTabs channels', () => {
    const source = readFileSync(join(__dirname, '../../preload/index.ts'), 'utf8')
    for (const channel of Object.values(cli.CLI_TAB_CHANNELS)) {
      expect(source).toContain(`'${channel}'`)
    }
  })
})

// The sandbox/secureWindow posture of this window is pinned centrally by
// base.securityContract.test.ts, which derives its file list from the directory.
