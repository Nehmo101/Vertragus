import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Like the profile editor's, this registry is an authorization root for IPC —
 * so it is tested without Electron: a fake BrowserWindow gives us the
 * webContents ↔ editor-key mapping and the window options. A provider editor
 * may write provider descriptors, which decide how every CLI is launched, so
 * "which window is this?" has to be answerable exactly.
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

type EditorModule = typeof import('./providerEditor')
let editor: EditorModule

beforeEach(async () => {
  vi.resetModules()
  vi.clearAllMocks()
  FakeBrowserWindow.instances = []
  listeners.clear()
  editor = await import('./providerEditor')
})

describe('openProviderEditorWindow', () => {
  it('is a resizable glass sheet that never floats above everything', () => {
    editor.openProviderEditorWindow('p1')
    const options = FakeBrowserWindow.instances[0]!.options

    expect(options.frame).toBe(false)
    expect(options.transparent).toBe(true)
    expect(options.resizable).toBe(true)
    expect(options.alwaysOnTop).toBe(false)
    expect(options.width).toBe(editor.PROVIDER_EDITOR_WIDTH)
    expect(options.minWidth).toBe(editor.PROVIDER_EDITOR_MIN_WIDTH)
  })

  it('loads the provider route and applies the navigation guard', () => {
    const win = editor.openProviderEditorWindow('my cli/x')
    expect(secureWindow).toHaveBeenCalledWith(win)
    expect(loadRoute).toHaveBeenCalledWith(win, `/provider-editor/${encodeURIComponent('my cli/x')}`)
  })

  it('loads the bare route for a provider that does not exist yet', () => {
    editor.openProviderEditorWindow()
    expect(loadRoute).toHaveBeenCalledWith(expect.anything(), '/provider-editor')
    expect(editor.providerEditorKey(undefined)).toBe(editor.NEW_PROVIDER_KEY)
    expect(editor.providerEditorKey('  ')).toBe(editor.NEW_PROVIDER_KEY)
  })

  it('refocuses the editor of the same provider instead of opening a second one', () => {
    const first = editor.openProviderEditorWindow('p1') as unknown as FakeBrowserWindow
    first.minimized = true
    const again = editor.openProviderEditorWindow('p1')

    expect(again).toBe(first as unknown as typeof again)
    expect(FakeBrowserWindow.instances).toHaveLength(1)
    expect(first.minimized).toBe(false)
    expect(first.focused).toBe(true)
  })

  it('keeps editors of different providers apart', () => {
    editor.openProviderEditorWindow('p1')
    editor.openProviderEditorWindow('p2')
    editor.openProviderEditorWindow()
    expect(FakeBrowserWindow.instances).toHaveLength(3)
    expect(editor.listProviderEditorWindows().map((entry) => entry.key)).toEqual([
      'p1',
      'p2',
      editor.NEW_PROVIDER_KEY
    ])
  })
})

describe('editor window registry', () => {
  it('maps a webContents id to exactly one editor key and rejects everything else', () => {
    const a = editor.openProviderEditorWindow('p1')
    const b = editor.openProviderEditorWindow()

    expect(editor.isProviderEditorWindowSender(a.webContents.id)).toBe('p1')
    expect(editor.isProviderEditorWindowSender(b.webContents.id)).toBe(editor.NEW_PROVIDER_KEY)
    expect(editor.isProviderEditorWindowSender(9999)).toBeNull()
  })

  it('forgets a window once it is closed', () => {
    const win = editor.openProviderEditorWindow('p1')
    const id = win.webContents.id
    editor.closeProviderEditorWindow('p1')

    expect(editor.getProviderEditorWindow('p1')).toBeNull()
    expect(editor.isProviderEditorWindowSender(id)).toBeNull()
    expect((win as unknown as FakeBrowserWindow).destroyed).toBe(true)
  })

  it('prunes destroyed windows that never fired closed', () => {
    const win = editor.openProviderEditorWindow('p1')
    ;(win as unknown as FakeBrowserWindow).destroyed = true

    expect(editor.getProviderEditorWindow('p1')).toBeNull()
    expect(editor.listProviderEditorWindows()).toEqual([])
  })

  it('closes every editor at once and shrugs at unknown keys', () => {
    editor.openProviderEditorWindow('p1')
    editor.openProviderEditorWindow('p2')
    editor.closeAllProviderEditorWindows()

    expect(editor.listProviderEditorWindows()).toEqual([])
    expect(() => editor.closeProviderEditorWindow('ghost')).not.toThrow()
  })
})

describe('security posture', () => {
  it('never weakens the sandbox flags', () => {
    const source = readFileSync(join(__dirname, 'providerEditor.ts'), 'utf8')
    expect(source).not.toMatch(/sandbox:\s*false/)
    expect(source).not.toMatch(/contextIsolation:\s*false/)
    expect(source).not.toMatch(/nodeIntegration:\s*true/)
    expect(source).not.toMatch(/webSecurity:\s*false/)
    expect(source).toMatch(/glassWindowOptions\(\)/)
    expect(source).toMatch(/secureWindow\(win\)/)
  })
})
