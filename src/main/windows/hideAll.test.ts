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
const getSettings = vi.fn(() => ({ hideAllHotkey: 'Control+Alt+V' }))
vi.mock('@main/store/settings', () => ({ getSettings: () => getSettings() }))
vi.mock('./cliWindow', () => ({ listCliWindows: () => [] }))
vi.mock('./profileEditor', () => ({ listProfileEditorWindows: () => [] }))
vi.mock('./providerEditor', () => ({ listProviderEditorWindows: () => [] }))
vi.mock('./settingsWindow', () => ({ listSettingsWindows: () => [] }))

import {
  createHideAllController,
  hideAllHotkeyStatus,
  registerAppHideAllShortcut,
  registerHideAllShortcut,
  reRegisterHideAllShortcut,
  resetHideAllForTesting,
  type HideAllTarget
} from './hideAll'

class FakeWindow {
  visible = true
  focused = false
  destroyed = false
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
