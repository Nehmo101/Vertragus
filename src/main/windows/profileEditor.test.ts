import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Like the CLI window registry, the editor registry is an authorization root
 * for IPC — so it is tested without Electron: a fake BrowserWindow gives us the
 * webContents ↔ editor-key mapping and the window options.
 */
const listeners = new Map<FakeBrowserWindow, Map<string, () => void>>()
let nextWebContentsId = 1

class FakeBrowserWindow {
  static instances: FakeBrowserWindow[] = []
  readonly webContents = { id: nextWebContentsId++, once: vi.fn() }
  destroyed = false
  shown = false
  focused = false
  minimized = false

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
  restore(): void {
    this.minimized = false
  }
  show(): void {
    this.shown = true
  }
  focus(): void {
    this.focused = true
  }
  close(): void {
    this.destroyed = true
    this.emit('closed')
  }
}

vi.mock('electron', () => ({ BrowserWindow: FakeBrowserWindow, app: { exit: vi.fn() } }))

const loadRoute = vi.fn()
const secureWindow = vi.fn()
vi.mock('./base', () => ({
  glassWindowOptions: () => ({ frame: false, transparent: true }),
  loadRoute: (...args: unknown[]) => loadRoute(...args),
  secureWindow: (...args: unknown[]) => secureWindow(...args)
}))

type EditorModule = typeof import('./profileEditor')
let editor: EditorModule

beforeEach(async () => {
  vi.resetModules()
  vi.clearAllMocks()
  FakeBrowserWindow.instances = []
  listeners.clear()
  editor = await import('./profileEditor')
})

describe('openProfileEditorWindow', () => {
  it('is a resizable glass sheet that never floats above everything', () => {
    editor.openProfileEditorWindow('p1')
    const options = FakeBrowserWindow.instances[0]!.options

    expect(options.frame).toBe(false)
    expect(options.transparent).toBe(true)
    expect(options.resizable).toBe(true)
    expect(options.alwaysOnTop).toBe(false)
    expect(options.width).toBe(editor.PROFILE_EDITOR_WIDTH)
    expect(options.minWidth).toBe(editor.PROFILE_EDITOR_MIN_WIDTH)
  })

  it('loads the profile route and applies the navigation guard', () => {
    const win = editor.openProfileEditorWindow('profile 1/x')
    expect(secureWindow).toHaveBeenCalledWith(win)
    expect(loadRoute).toHaveBeenCalledWith(win, `/profile-editor/${encodeURIComponent('profile 1/x')}`)
  })

  it('loads the bare route for a profile that does not exist yet', () => {
    editor.openProfileEditorWindow()
    expect(loadRoute).toHaveBeenCalledWith(expect.anything(), '/profile-editor')
    expect(editor.profileEditorKey(undefined)).toBe(editor.NEW_PROFILE_KEY)
    expect(editor.profileEditorKey('  ')).toBe(editor.NEW_PROFILE_KEY)
  })

  it('carries the WP-7 orchestrator hint on the new-profile route only', () => {
    editor.openProfileEditorWindow(undefined, 'codex')
    expect(loadRoute).toHaveBeenCalledWith(expect.anything(), '/profile-editor?provider=codex')

    // An existing profile names its own orchestrator; a query parameter that
    // repointed a saved record would be data loss dressed up as convenience.
    editor.openProfileEditorWindow('p1', 'codex')
    expect(loadRoute).toHaveBeenLastCalledWith(expect.anything(), '/profile-editor/p1')
  })

  it('escapes and drops a blank hint instead of emitting a broken route', () => {
    expect(editor.profileEditorRoute(editor.NEW_PROFILE_KEY, 'a b&c')).toBe(
      '/profile-editor?provider=a%20b%26c'
    )
    expect(editor.profileEditorRoute(editor.NEW_PROFILE_KEY, '  ')).toBe('/profile-editor')
    expect(editor.profileEditorRoute(editor.NEW_PROFILE_KEY)).toBe('/profile-editor')
  })

  it('refocuses the editor of the same profile instead of opening a second one', () => {
    const first = editor.openProfileEditorWindow('p1') as unknown as FakeBrowserWindow
    first.minimized = true
    const again = editor.openProfileEditorWindow('p1')

    expect(again).toBe(first as unknown as typeof again)
    expect(FakeBrowserWindow.instances).toHaveLength(1)
    expect(first.minimized).toBe(false)
    expect(first.focused).toBe(true)
  })

  it('keeps editors of different profiles apart', () => {
    editor.openProfileEditorWindow('p1')
    editor.openProfileEditorWindow('p2')
    editor.openProfileEditorWindow()
    expect(FakeBrowserWindow.instances).toHaveLength(3)
    expect(editor.listProfileEditorWindows().map((entry) => entry.key)).toEqual([
      'p1',
      'p2',
      editor.NEW_PROFILE_KEY
    ])
  })
})

describe('editor window registry', () => {
  it('maps a webContents id to exactly one editor key and rejects everything else', () => {
    const a = editor.openProfileEditorWindow('p1')
    const b = editor.openProfileEditorWindow()

    expect(editor.isProfileEditorWindowSender(a.webContents.id)).toBe('p1')
    expect(editor.isProfileEditorWindowSender(b.webContents.id)).toBe(editor.NEW_PROFILE_KEY)
    expect(editor.isProfileEditorWindowSender(9999)).toBeNull()
  })

  it('forgets a window once it is closed', () => {
    const win = editor.openProfileEditorWindow('p1')
    const id = win.webContents.id
    editor.closeProfileEditorWindow('p1')

    expect(editor.getProfileEditorWindow('p1')).toBeNull()
    expect(editor.isProfileEditorWindowSender(id)).toBeNull()
    expect((win as unknown as FakeBrowserWindow).destroyed).toBe(true)
  })

  it('prunes destroyed windows that never fired closed', () => {
    const win = editor.openProfileEditorWindow('p1')
    ;(win as unknown as FakeBrowserWindow).destroyed = true

    expect(editor.getProfileEditorWindow('p1')).toBeNull()
    expect(editor.listProfileEditorWindows()).toEqual([])
  })

  it('closes every editor at once and shrugs at unknown keys', () => {
    editor.openProfileEditorWindow('p1')
    editor.openProfileEditorWindow('p2')
    editor.closeAllProfileEditorWindows()

    expect(editor.listProfileEditorWindows()).toEqual([])
    expect(() => editor.closeProfileEditorWindow('ghost')).not.toThrow()
  })
})

// The sandbox/secureWindow posture of this window is pinned centrally by
// base.securityContract.test.ts, which derives its file list from the directory.
