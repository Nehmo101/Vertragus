import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Hide-all is exercised against fake windows: what matters is the bookkeeping
 * (which windows, in which order, with which focus at the end) — not Electron.
 * The production module still imports electron and the settings store, so both
 * are mocked away wholesale.
 */
const register = vi.fn((_accelerator: string, _callback: () => void): boolean => true)
const unregisterAll = vi.fn()
vi.mock('electron', () => ({
  globalShortcut: {
    register: (accelerator: string, callback: () => void) => register(accelerator, callback),
    unregisterAll: () => unregisterAll()
  }
}))
const getSettings = vi.fn(() => ({
  hideAllHotkey: 'Control+Alt+V',
  ui: { snapToZones: true }
}))
vi.mock('@main/store/settings', () => ({ getSettings: () => getSettings() }))
vi.mock('./cliWindow', () => ({
  listCliWindows: vi.fn(() => []),
  layoutCliWindowsByWorkspace: vi.fn()
}))
vi.mock('./profileEditor', () => ({
  listProfileEditorWindows: vi.fn(() => [])
}))
vi.mock('./providerEditor', () => ({ listProviderEditorWindows: () => [] }))
vi.mock('./settingsWindow', () => ({ listSettingsWindows: () => [] }))
vi.mock('./timelineWindow', () => ({ listTimelineWindows: vi.fn(() => []) }))

import { layoutCliWindowsByWorkspace, listCliWindows } from './cliWindow'
import { listProfileEditorWindows } from './profileEditor'
import { listTimelineWindows } from './timelineWindow'
import {
  createHideAllController,
  forgetHideAll,
  hideAllHotkeyStatus,
  isEverythingHidden,
  registerAppHideAllShortcut,
  registerHideAllShortcut,
  reRegisterHideAllShortcut,
  resetHideAllForTesting,
  setHideAllRestoreWorkspace,
  toggleHideAll,
  type HideAllTarget
} from './hideAll'

class FakeWindow {
  visible = true
  focused = false
  destroyed = false
  minimized = false
  readonly log: string[]

  constructor(
    readonly key: string,
    log: string[]
  ) {
    this.log = log
  }

  isDestroyed(): boolean {
    return this.destroyed
  }
  isVisible(): boolean {
    return this.visible
  }
  isMinimized(): boolean {
    return this.minimized
  }
  isFocused(): boolean {
    return this.focused
  }
  hide(): void {
    this.visible = false
    this.focused = false
    this.log.push(`hide:${this.key}`)
  }
  showInactive(): void {
    this.visible = true
    this.log.push(`show:${this.key}`)
  }
  focus(): void {
    this.focused = true
    this.log.push(`focus:${this.key}`)
  }
}

function harness(keys: string[]): {
  log: string[]
  windows: Record<string, FakeWindow>
  targets: HideAllTarget[]
} {
  const log: string[] = []
  const windows: Record<string, FakeWindow> = {}
  const targets = keys.map((key) => {
    const window = new FakeWindow(key, log)
    windows[key] = window
    return { key, window }
  })
  return { log, windows, targets }
}

beforeEach(() => {
  vi.clearAllMocks()
  register.mockImplementation(() => true)
  resetHideAllForTesting()
  vi.mocked(listCliWindows).mockReturnValue([])
  vi.mocked(layoutCliWindowsByWorkspace).mockReset()
  vi.mocked(listProfileEditorWindows).mockReset()
  vi.mocked(listProfileEditorWindows).mockReturnValue([])
  vi.mocked(listTimelineWindows).mockReturnValue([])
  getSettings.mockReturnValue({
    hideAllHotkey: 'Control+Alt+V',
    ui: { snapToZones: true }
  })
})

describe('toggle', () => {
  it('hides every target and brings them back in the same order', () => {
    const { log, targets } = harness(['a', 'b', 'c'])
    const hideAll = createHideAllController({ targets: () => targets })

    expect(hideAll.toggle()).toBe('hidden')
    expect(hideAll.isHidden()).toBe(true)
    expect(log).toEqual(['hide:a', 'hide:b', 'hide:c'])

    log.length = 0
    expect(hideAll.toggle()).toBe('restored')
    expect(hideAll.isHidden()).toBe(false)
    expect(log).toEqual(['show:a', 'show:b', 'show:c'])
  })

  it('is the identity: two toggles restore the exact visibility it found', () => {
    const { windows, targets } = harness(['a', 'b'])
    windows.b!.visible = false
    const hideAll = createHideAllController({ targets: () => targets })

    hideAll.toggle()
    hideAll.toggle()

    expect(windows.a!.visible).toBe(true)
    // Hidden before the toggle, hidden after — it was never ours.
    expect(windows.b!.visible).toBe(false)
  })

  it('leaves a user-minimized window alone across a hide-all roundtrip', () => {
    const { log, windows, targets } = harness(['a', 'b'])
    windows.b!.minimized = true
    const hideAll = createHideAllController({ targets: () => targets })

    expect(hideAll.toggle()).toBe('hidden')
    expect(log).toEqual(['hide:a'])
    expect(windows.b!.minimized).toBe(true)
    expect(windows.b!.visible).toBe(true)

    log.length = 0
    expect(hideAll.toggle()).toBe('restored')
    expect(log).toEqual(['show:a'])
    // Minimized before the toggle, still minimized after — never restored.
    expect(windows.b!.minimized).toBe(true)
    expect(windows.b!.visible).toBe(true)
  })

  it('restores focus once, to the window that had it', () => {
    const { log, windows, targets } = harness(['a', 'b', 'c'])
    windows.b!.focused = true
    const hideAll = createHideAllController({ targets: () => targets })

    hideAll.toggle()
    log.length = 0
    hideAll.toggle()

    expect(log).toEqual(['show:a', 'show:b', 'show:c', 'focus:b'])
    expect(log.filter((entry) => entry.startsWith('focus:'))).toHaveLength(1)
  })

  it('hides a shared parent once (tab chrome)', () => {
    const { log, windows, targets } = harness(['orch'])
    targets.push({ key: 'worker', window: windows.orch! })
    const hideAll = createHideAllController({ targets: () => targets })

    expect(hideAll.toggle()).toBe('hidden')
    expect(log).toEqual(['hide:orch'])

    log.length = 0
    expect(hideAll.toggle()).toBe('restored')
    expect(log).toEqual(['show:orch'])
  })

  it('never touches a window that is not a target — the panel survives', () => {
    const { log, targets } = harness(['a'])
    const panel = new FakeWindow('panel', log)
    const hideAll = createHideAllController({ targets: () => targets })

    hideAll.toggle()

    expect(panel.visible).toBe(true)
    expect(log).toEqual(['hide:a'])
  })

  it('shrugs at windows that were destroyed while hidden', () => {
    const { log, windows, targets } = harness(['a', 'b'])
    const hideAll = createHideAllController({ targets: () => targets })
    hideAll.toggle()
    windows.a!.destroyed = true
    log.length = 0

    expect(() => hideAll.toggle()).not.toThrow()
    expect(log).toEqual(['show:b'])
  })

  it('picks up windows that opened while everything was hidden', () => {
    const { log, targets } = harness(['a'])
    const hideAll = createHideAllController({ targets: () => targets })
    hideAll.toggle()

    const late = new FakeWindow('late', log)
    targets.push({ key: 'late', window: late })
    log.length = 0
    hideAll.toggle()

    // The late window was never hidden, so restoring leaves it alone …
    expect(log).toEqual(['show:a'])
    // … and the next hide takes it with everything else.
    log.length = 0
    hideAll.toggle()
    expect(log).toEqual(['hide:a', 'hide:late'])
  })

  it('forgets its memory on reset', () => {
    const { log, targets } = harness(['a'])
    const hideAll = createHideAllController({ targets: () => targets })
    hideAll.toggle()
    hideAll.reset()
    log.length = 0

    expect(hideAll.isHidden()).toBe(false)
    hideAll.toggle()
    // Nothing to hide (already hidden), so nothing happens — and no restore.
    expect(log).toEqual([])
  })

  it('reset then toggle hides what is visible instead of restoring the previous hide', () => {
    const { log, windows, targets } = harness(['a', 'b'])
    const hideAll = createHideAllController({ targets: () => targets })
    hideAll.toggle()
    // Workspace click showed `a`; `b` stays hidden.
    windows.a!.visible = true
    hideAll.reset()
    log.length = 0

    expect(hideAll.isHidden()).toBe(false)
    expect(hideAll.toggle()).toBe('hidden')
    expect(log).toEqual(['hide:a'])
    expect(windows.b!.visible).toBe(false)
    expect(log).not.toContain('show:b')
  })

  it('snaps after hide and after restore', () => {
    const { log, targets } = harness(['agent:a', 'editor:p', 'settings:s'])
    const snapCliWindows = vi.fn((keys: readonly string[]) => {
      log.push(`snap:${keys.join(',')}`)
    })
    const hideAll = createHideAllController({ targets: () => targets, snapCliWindows })

    hideAll.toggle()
    expect(log).toEqual([
      'hide:agent:a',
      'hide:editor:p',
      'hide:settings:s',
      'snap:agent:a,editor:p,settings:s'
    ])
    expect(snapCliWindows).toHaveBeenCalledTimes(1)

    log.length = 0
    hideAll.toggle()
    expect(log).toEqual([
      'show:agent:a',
      'show:editor:p',
      'show:settings:s',
      'snap:agent:a,editor:p,settings:s'
    ])
  })

  it('suppresses native visibility before hide and before show', () => {
    const { log, windows, targets } = harness(['agent:a', 'agent:b'])
    windows['agent:b']!.minimized = true
    const beforeNativeVisibility = vi.fn((key: string) => {
      log.push(`prep:${key}`)
    })
    const hideAll = createHideAllController({ targets: () => targets, beforeNativeVisibility })

    hideAll.toggle()
    expect(log).toEqual(['prep:agent:a', 'hide:agent:a'])
    expect(beforeNativeVisibility).not.toHaveBeenCalledWith('agent:b')

    log.length = 0
    hideAll.toggle()
    expect(log[0]).toBe('prep:agent:a')
    expect(log).toEqual(['prep:agent:a', 'show:agent:a'])
  })

  it('does not snap a user-minimized window that hide-all left alone', () => {
    const { targets, windows } = harness(['agent:a', 'agent:b'])
    windows['agent:b']!.minimized = true
    const snapCliWindows = vi.fn()
    const hideAll = createHideAllController({ targets: () => targets, snapCliWindows })

    hideAll.toggle()
    expect(snapCliWindows).toHaveBeenCalledWith(['agent:a'])
    hideAll.toggle()
    expect(snapCliWindows).toHaveBeenLastCalledWith(['agent:a'])
  })

  it('restore goes through restoreWorkspace and leaves foreign CLI hidden', () => {
    const { log, windows, targets } = harness([
      'agent:last',
      'agent:foreign',
      'editor:p',
      'timeline:t'
    ])
    const snapCliWindows = vi.fn()
    const restoreWorkspace = vi.fn(() => {
      windows['agent:last']!.visible = true
      log.push('restoreWorkspace')
      log.push('focus:agent:last')
      return true
    })
    const hideAll = createHideAllController({
      targets: () => targets,
      snapCliWindows,
      restoreWorkspace
    })

    expect(hideAll.toggle()).toBe('hidden')
    expect(restoreWorkspace).not.toHaveBeenCalled()
    snapCliWindows.mockClear()
    log.length = 0

    expect(hideAll.toggle()).toBe('restored')
    expect(restoreWorkspace).toHaveBeenCalledTimes(1)
    expect(snapCliWindows).not.toHaveBeenCalled()
    expect(log).toEqual(['restoreWorkspace', 'focus:agent:last', 'show:editor:p'])
    expect(log.filter((entry) => entry.startsWith('focus:'))).toEqual(['focus:agent:last'])
    expect(windows['agent:foreign']!.visible).toBe(false)
    expect(windows['agent:last']!.visible).toBe(true)
    expect(windows['editor:p']!.visible).toBe(true)
    expect(windows['timeline:t']!.visible).toBe(false)
    expect(hideAll.isHidden()).toBe(false)
  })

  it('falls back to the snapshot when restoreWorkspace returns false', () => {
    const { log, targets } = harness(['agent:a', 'editor:p'])
    const restoreWorkspace = vi.fn(() => false)
    const hideAll = createHideAllController({ targets: () => targets, restoreWorkspace })

    hideAll.toggle()
    log.length = 0
    expect(hideAll.toggle()).toBe('restored')
    expect(log).toEqual(['show:agent:a', 'show:editor:p'])
  })

  it('falls back to the snapshot when restoreWorkspace is absent', () => {
    const { log, targets } = harness(['agent:a', 'editor:p'])
    const hideAll = createHideAllController({ targets: () => targets })

    hideAll.toggle()
    log.length = 0
    expect(hideAll.toggle()).toBe('restored')
    expect(log).toEqual(['show:agent:a', 'show:editor:p'])
  })

  it('opens the last workspace when nothing is hidden and no target is visible', () => {
    const { log, windows, targets } = harness(['agent:a', 'editor:p'])
    windows['agent:a']!.visible = false
    windows['editor:p']!.visible = false
    const restoreWorkspace = vi.fn(() => {
      log.push('restoreWorkspace')
      return true
    })
    const hideAll = createHideAllController({ targets: () => targets, restoreWorkspace })

    expect(hideAll.toggle()).toBe('restored')
    expect(restoreWorkspace).toHaveBeenCalledTimes(1)
    expect(log).toEqual(['restoreWorkspace'])
    expect(hideAll.isHidden()).toBe(false)
  })

  it('hides a visible timeline when CLI windows are closed rather than restoring', () => {
    const { log, windows, targets } = harness(['agent:a', 'timeline:t'])
    windows['agent:a']!.visible = false
    const restoreWorkspace = vi.fn(() => true)
    const hideAll = createHideAllController({ targets: () => targets, restoreWorkspace })

    expect(hideAll.toggle()).toBe('hidden')
    expect(restoreWorkspace).not.toHaveBeenCalled()
    expect(log).toEqual(['hide:timeline:t'])
    expect(windows['timeline:t']!.visible).toBe(false)
  })

  it('keeps today\'s empty hide when restoreWorkspace returns false and nothing is visible', () => {
    const { log, windows, targets } = harness(['agent:a'])
    windows['agent:a']!.visible = false
    const restoreWorkspace = vi.fn(() => false)
    const hideAll = createHideAllController({ targets: () => targets, restoreWorkspace })

    expect(hideAll.toggle()).toBe('hidden')
    expect(log).toEqual([])
    expect(hideAll.isHidden()).toBe(false)
  })

  it('still hides visible CLI when restoreWorkspace is wired', () => {
    const { log, targets } = harness(['agent:a', 'editor:p'])
    const restoreWorkspace = vi.fn(() => true)
    const hideAll = createHideAllController({ targets: () => targets, restoreWorkspace })

    expect(hideAll.toggle()).toBe('hidden')
    expect(restoreWorkspace).not.toHaveBeenCalled()
    expect(log).toEqual(['hide:agent:a', 'hide:editor:p'])
  })
})

describe('production snapToZones', () => {
  it('snaps only CLI windows on hide and restore when the flag is on', () => {
    const { windows } = harness(['a', 'b', 'ed'])
    vi.mocked(listCliWindows).mockReturnValue([
      { agentId: 'a', window: windows.a as never },
      { agentId: 'b', window: windows.b as never }
    ])
    vi.mocked(listProfileEditorWindows).mockReturnValue([
      { key: 'p', window: windows.ed as never }
    ])

    expect(toggleHideAll()).toBe('hidden')
    expect(layoutCliWindowsByWorkspace).toHaveBeenCalledTimes(1)
    expect(layoutCliWindowsByWorkspace).toHaveBeenCalledWith(['a', 'b'])
    vi.mocked(layoutCliWindowsByWorkspace).mockClear()
    expect(toggleHideAll()).toBe('restored')
    expect(layoutCliWindowsByWorkspace).toHaveBeenCalledWith(['a', 'b'])
  })

  it('does not re-tile when snapToZones is off', () => {
    getSettings.mockReturnValue({
      hideAllHotkey: 'Control+Alt+V',
      ui: { snapToZones: false }
    })
    const { windows } = harness(['a'])
    vi.mocked(listCliWindows).mockReturnValue([{ agentId: 'a', window: windows.a as never }])

    expect(toggleHideAll()).toBe('hidden')
    expect(layoutCliWindowsByWorkspace).not.toHaveBeenCalled()
    expect(toggleHideAll()).toBe('restored')
    expect(layoutCliWindowsByWorkspace).not.toHaveBeenCalled()
  })

  it('never calls minimize or restore on a hide-all target', () => {
    const source = readFileSync(join(__dirname, 'hideAll.ts'), 'utf8')
    expect(source).not.toMatch(/window\.minimize\s*\(/)
    expect(source).not.toMatch(/window\.restore\s*\(/)
    const iface = source.slice(
      source.indexOf('export interface HideableWindow'),
      source.indexOf('export interface HideAllTarget')
    )
    expect(iface).not.toMatch(/\bminimize\b/)
    expect(iface).not.toMatch(/\brestore\b/)
  })
})

describe('timeline membership', () => {
  it('hides timeline windows from the production target list', () => {
    const { log, windows } = harness(['w1'])
    vi.mocked(listTimelineWindows).mockReturnValue([
      { workspaceId: 'w1', window: windows.w1 as never }
    ])

    expect(toggleHideAll()).toBe('hidden')
    expect(log).toEqual(['hide:w1'])
    expect(windows.w1!.visible).toBe(false)
  })

  it('names them timeline:<workspaceId> and never minimize()/restore()', () => {
    const source = readFileSync(join(__dirname, 'hideAll.ts'), 'utf8')
    expect(source).toMatch(/listTimelineWindows/)
    expect(source).toMatch(/timeline:\$\{workspaceId\}/)
    expect(source).toMatch(/never `minimize\(\)` \/ `restore\(\)`/)
  })
})

describe('production restoreWorkspace hook', () => {
  it('restore goes through the registered hook and still shows editors', () => {
    const { windows } = harness(['a', 'ed'])
    vi.mocked(listCliWindows).mockReturnValue([{ agentId: 'a', window: windows.a as never }])
    vi.mocked(listProfileEditorWindows).mockReturnValue([
      { key: 'p', window: windows.ed as never }
    ])
    const restoreWorkspace = vi.fn(() => {
      windows.a!.visible = true
      return true
    })
    setHideAllRestoreWorkspace(restoreWorkspace)

    expect(toggleHideAll()).toBe('hidden')
    expect(restoreWorkspace).not.toHaveBeenCalled()
    expect(windows.ed!.visible).toBe(false)
    expect(toggleHideAll()).toBe('restored')
    expect(restoreWorkspace).toHaveBeenCalledTimes(1)
    expect(windows.ed!.visible).toBe(true)
    expect(windows.a!.visible).toBe(true)
  })
})

describe('forgetHideAll', () => {
  it('clears live memory so the next toggle hides, not restores', () => {
    const { log, windows } = harness(['a', 'b'])
    vi.mocked(listCliWindows).mockReturnValue([
      { agentId: 'a', window: windows.a as never },
      { agentId: 'b', window: windows.b as never }
    ])

    expect(toggleHideAll()).toBe('hidden')
    expect(isEverythingHidden()).toBe(true)
    windows.a!.visible = true
    forgetHideAll()
    expect(isEverythingHidden()).toBe(false)

    log.length = 0
    expect(toggleHideAll()).toBe('hidden')
    expect(log).toEqual(['hide:a'])
    expect(windows.b!.visible).toBe(false)
    expect(log).not.toContain('show:b')
  })
})

describe('the global shortcut', () => {
  it('registers the configured accelerator', () => {
    const status = registerHideAllShortcut({
      hotkey: 'Control+Alt+V',
      register,
      unregisterAll,
      onToggle: () => undefined
    })

    expect(unregisterAll).toHaveBeenCalled()
    expect(register).toHaveBeenCalledWith('Control+Alt+V', expect.any(Function))
    expect(status).toEqual({ hotkey: 'Control+Alt+V', registered: true })
    expect(hideAllHotkeyStatus()).toEqual(status)
  })

  it('reports a taken combination instead of failing silently', () => {
    register.mockImplementation(() => false)
    const status = registerHideAllShortcut({
      hotkey: 'Control+Alt+V',
      register,
      unregisterAll,
      onToggle: () => undefined
    })

    expect(status.registered).toBe(false)
    expect(status.error).toContain('Control+Alt+V')
  })

  it('turns a malformed accelerator into a status, not a boot crash', () => {
    register.mockImplementation(() => {
      throw new Error('Invalid accelerator')
    })
    const status = registerHideAllShortcut({
      hotkey: 'Nonsense++',
      register,
      unregisterAll,
      onToggle: () => undefined
    })

    expect(status.registered).toBe(false)
    expect(status.error).toContain('Invalid accelerator')
  })

  it('refuses an empty hotkey with a reason', () => {
    const status = registerHideAllShortcut({
      hotkey: '   ',
      register,
      unregisterAll,
      onToggle: () => undefined
    })

    expect(status).toEqual({ hotkey: '', registered: false, error: 'Kein Hotkey konfiguriert.' })
    expect(register).not.toHaveBeenCalled()
  })

  it('reads the accelerator from the settings store in production', () => {
    const status = registerAppHideAllShortcut()

    expect(register).toHaveBeenCalledWith('Control+Alt+V', expect.any(Function))
    expect(status.registered).toBe(true)
  })

  it('re-registers a new accelerator the moment the settings window saves it', () => {
    registerAppHideAllShortcut()
    unregisterAll.mockClear()
    register.mockClear()

    const status = reRegisterHideAllShortcut('Control+Shift+H')

    // Old one dropped first — two live registrations would both fire the toggle.
    expect(unregisterAll).toHaveBeenCalledTimes(1)
    expect(register).toHaveBeenCalledTimes(1)
    expect(register).toHaveBeenCalledWith('Control+Shift+H', expect.any(Function))
    expect(status).toEqual({ hotkey: 'Control+Shift+H', registered: true })
    expect(hideAllHotkeyStatus()).toEqual(status)
  })

  it('reports a re-registration that the OS refused, and keeps saying so', () => {
    registerAppHideAllShortcut()
    register.mockImplementation(() => false)

    const status = reRegisterHideAllShortcut('Control+Alt+Space')

    expect(status.registered).toBe(false)
    expect(status.error).toContain('Control+Alt+Space')
    // The status the panel reads is the failed one, not the old success.
    expect(hideAllHotkeyStatus()).toEqual(status)
  })

  it('turns a malformed accelerator from the settings form into a status', () => {
    register.mockImplementation(() => {
      throw new Error('Invalid accelerator')
    })
    const status = reRegisterHideAllShortcut('Strg+Ö')

    expect(status.registered).toBe(false)
    expect(status.error).toContain('Invalid accelerator')
  })

  it('survives an unreadable settings file', () => {
    getSettings.mockImplementationOnce(() => {
      throw new Error('config.json is corrupt')
    })
    const status = registerAppHideAllShortcut()

    expect(status.registered).toBe(false)
    expect(status.error).toContain('config.json is corrupt')
  })
})
