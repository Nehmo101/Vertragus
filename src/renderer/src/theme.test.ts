import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  applyTheme,
  DEFAULT_THEME,
  followStoredTheme,
  isTheme,
  THEME_BOOT_TIMEOUT_MS
} from './theme'

describe('theme helpers', () => {
  it('accepts only dark and light', () => {
    expect(isTheme('dark')).toBe(true)
    expect(isTheme('light')).toBe(true)
    expect(isTheme('neon')).toBe(false)
    expect(isTheme(undefined)).toBe(false)
  })

  it('sets data-theme on the root and ignores junk', () => {
    const root = {
      attr: null as string | null,
      getAttribute(name: string): string | null {
        return name === 'data-theme' ? this.attr : null
      },
      setAttribute(name: string, value: string): void {
        if (name === 'data-theme') this.attr = value
      },
      hasAttribute(name: string): boolean {
        return name === 'data-theme' && this.attr !== null
      },
      removeAttribute(name: string): void {
        if (name === 'data-theme') this.attr = null
      }
    }
    applyTheme('light', root as unknown as HTMLElement)
    expect(root.attr).toBe('light')
    applyTheme('neon', root as unknown as HTMLElement)
    expect(root.attr).toBe('light')
    applyTheme('dark', root as unknown as HTMLElement)
    expect(root.attr).toBe('dark')
  })
})

describe('following the stored theme', () => {
  interface FakeBridge {
    getSettings(): Promise<{ theme: string }>
    onSettings(listener: (settings: { theme: string }) => void): () => void
  }

  interface FakeRoot {
    attr: string | null
    getAttribute(name: string): string | null
    setAttribute(name: string, value: string): void
    hasAttribute(name: string): boolean
    removeAttribute(name: string): void
  }

  function fakeRoot(): FakeRoot {
    return {
      attr: null,
      getAttribute(name) {
        return name === 'data-theme' ? this.attr : null
      },
      setAttribute(name, value) {
        if (name === 'data-theme') this.attr = value
      },
      hasAttribute(name) {
        return name === 'data-theme' && this.attr !== null
      },
      removeAttribute(name) {
        if (name === 'data-theme') this.attr = null
      }
    }
  }

  function withBridge(bridge: FakeBridge | undefined, root: FakeRoot): () => void {
    const globals = globalThis as unknown as {
      window?: unknown
      document?: { documentElement: FakeRoot }
    }
    const previousWindow = globals.window
    const previousDocument = globals.document
    globals.window = bridge ? { vertragus: { app: bridge } } : {}
    globals.document = { documentElement: root }
    return () => {
      if (previousWindow === undefined) delete globals.window
      else globals.window = previousWindow
      if (previousDocument === undefined) delete globals.document
      else globals.document = previousDocument
    }
  }

  afterEach(() => {
    vi.useRealTimers()
  })

  it('adopts the stored theme before the window paints', async () => {
    const root = fakeRoot()
    const restore = withBridge(
      {
        getSettings: () => Promise.resolve({ theme: 'light' }),
        onSettings: () => () => undefined
      },
      root
    )
    try {
      await followStoredTheme()
      expect(root.attr).toBe('light')
    } finally {
      restore()
    }
  })

  it('follows a later broadcast, and ignores a value that is not a theme', async () => {
    const root = fakeRoot()
    let push: ((settings: { theme: string }) => void) | undefined
    const restore = withBridge(
      {
        getSettings: () => Promise.resolve({ theme: 'dark' }),
        onSettings: (listener) => {
          push = listener
          return () => {
            push = undefined
          }
        }
      },
      root
    )
    try {
      const off = await followStoredTheme()
      expect(root.attr).toBe('dark')

      push?.({ theme: 'light' })
      expect(root.attr).toBe('light')

      push?.({ theme: 'neon' })
      expect(root.attr).toBe('light')

      off()
      expect(push).toBeUndefined()
    } finally {
      restore()
    }
  })

  it('keeps the default when the bridge refuses — a CLI window may not read settings', async () => {
    const root = fakeRoot()
    const restore = withBridge(
      {
        getSettings: () => Promise.reject(new Error('settings:get rejected — not an app window')),
        onSettings: () => () => undefined
      },
      root
    )
    try {
      await followStoredTheme()
      expect(root.attr).toBe(DEFAULT_THEME)
    } finally {
      restore()
    }
  })

  it('survives a window without any bridge at all', async () => {
    const root = fakeRoot()
    const restore = withBridge(undefined, root)
    try {
      const off = await followStoredTheme()
      expect(() => off()).not.toThrow()
      expect(root.attr).toBe(DEFAULT_THEME)
    } finally {
      restore()
    }
  })

  it('does not wait forever when getSettings hangs', async () => {
    vi.useFakeTimers()
    const root = fakeRoot()
    const restore = withBridge(
      {
        getSettings: () => new Promise(() => undefined),
        onSettings: () => () => undefined
      },
      root
    )
    try {
      const pending = followStoredTheme()
      await vi.advanceTimersByTimeAsync(THEME_BOOT_TIMEOUT_MS)
      await pending
      expect(root.attr).toBe(DEFAULT_THEME)
    } finally {
      restore()
    }
  })
})
