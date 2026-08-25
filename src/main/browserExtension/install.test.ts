import { posix, win32 } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  CHROMIUM_EXTENSIONS_PAGE,
  installChromiumExtension,
  pickChromiumBrowser,
  type SpawnHandle
} from './install'

function existsIn(...paths: string[]): (path: string) => boolean {
  const set = new Set(paths)
  return (path) => set.has(path)
}

function spawnRecorder(): {
  spawn: (command: string, args: readonly string[]) => SpawnHandle
  calls: Array<{ command: string; args: readonly string[] }>
} {
  const calls: Array<{ command: string; args: readonly string[] }> = []
  return {
    calls,
    spawn: (command, args) => {
      calls.push({ command, args })
      return { unref: vi.fn() }
    }
  }
}

describe('pickChromiumBrowser', () => {
  it('picks Google Chrome from a Linux PATH before Chromium', () => {
    const chrome = posix.join('/usr/bin', 'google-chrome-stable')
    const chromium = posix.join('/usr/bin', 'chromium')
    expect(
      pickChromiumBrowser({
        platform: 'linux',
        homedir: () => '/home/ada',
        env: { PATH: '/opt/bin:/usr/bin' },
        exists: existsIn(chrome, chromium)
      })
    ).toEqual({
      id: 'chrome',
      label: 'Google Chrome',
      command: chrome,
      args: [CHROMIUM_EXTENSIONS_PAGE]
    })
  })

  it('falls back to a well-known Linux path when PATH is empty', () => {
    expect(
      pickChromiumBrowser({
        platform: 'linux',
        homedir: () => '/home/ada',
        env: { PATH: '' },
        exists: existsIn('/opt/google/chrome/google-chrome')
      })?.command
    ).toBe('/opt/google/chrome/google-chrome')
  })

  it('picks Chromium from PATH when Chrome is absent', () => {
    const chromium = posix.join('/usr/bin', 'chromium')
    expect(
      pickChromiumBrowser({
        platform: 'linux',
        homedir: () => '/home/ada',
        env: { PATH: '/usr/bin' },
        exists: existsIn(chromium)
      })?.id
    ).toBe('chromium')
  })

  it('opens a Darwin app bundle via /usr/bin/open when the inner binary is missing', () => {
    const bundle = '/Applications/Google Chrome.app'
    expect(
      pickChromiumBrowser({
        platform: 'darwin',
        homedir: () => '/Users/ada',
        env: {},
        exists: existsIn(bundle)
      })
    ).toEqual({
      id: 'chrome',
      label: 'Google Chrome',
      command: '/usr/bin/open',
      args: ['-a', bundle, CHROMIUM_EXTENSIONS_PAGE]
    })
  })

  it('spawns the Darwin inner binary when it exists', () => {
    const bundle = '/Applications/Google Chrome.app'
    const inner = posix.join(bundle, 'Contents', 'MacOS', 'Google Chrome')
    expect(
      pickChromiumBrowser({
        platform: 'darwin',
        homedir: () => '/Users/ada',
        env: {},
        exists: existsIn(bundle, inner)
      })
    ).toEqual({
      id: 'chrome',
      label: 'Google Chrome',
      command: inner,
      args: [CHROMIUM_EXTENSIONS_PAGE]
    })
  })

  it('looks in ~/Applications on Darwin', () => {
    const bundle = posix.join('/Users/ada', 'Applications', 'Brave Browser.app')
    expect(
      pickChromiumBrowser({
        platform: 'darwin',
        homedir: () => '/Users/ada',
        env: {},
        exists: existsIn(bundle)
      })?.id
    ).toBe('brave')
  })

  it('picks chrome.exe from the Windows PATH', () => {
    const chrome = win32.join('D:\\tools', 'chrome.exe')
    expect(
      pickChromiumBrowser({
        platform: 'win32',
        homedir: () => 'C:\\Users\\ada',
        env: { Path: 'D:\\tools' },
        exists: existsIn(chrome)
      })?.command
    ).toBe(chrome)
  })

  it('picks Chrome from Windows Program Files', () => {
    const chrome = win32.join('C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe')
    expect(
      pickChromiumBrowser({
        platform: 'win32',
        homedir: () => 'C:\\Users\\ada',
        env: { PROGRAMFILES: 'C:\\Program Files' },
        exists: existsIn(chrome)
      })
    ).toEqual({
      id: 'chrome',
      label: 'Google Chrome',
      command: chrome,
      args: [CHROMIUM_EXTENSIONS_PAGE]
    })
  })

  it('picks Edge from Program Files (x86) when Chrome is missing', () => {
    const edge = win32.join(
      'C:\\Program Files (x86)',
      'Microsoft',
      'Edge',
      'Application',
      'msedge.exe'
    )
    expect(
      pickChromiumBrowser({
        platform: 'win32',
        homedir: () => 'C:\\Users\\ada',
        env: { 'PROGRAMFILES(X86)': 'C:\\Program Files (x86)' },
        exists: existsIn(edge)
      })?.id
    ).toBe('edge')
  })

  it('picks Brave from Windows LocalAppData when Chrome is missing', () => {
    const brave = win32.join(
      'C:\\Users\\ada\\AppData\\Local',
      'BraveSoftware',
      'Brave-Browser',
      'Application',
      'brave.exe'
    )
    expect(
      pickChromiumBrowser({
        platform: 'win32',
        homedir: () => 'C:\\Users\\ada',
        env: { LOCALAPPDATA: 'C:\\Users\\ada\\AppData\\Local' },
        exists: existsIn(brave)
      })?.id
    ).toBe('brave')
  })

  it('returns undefined when nothing Chromium-like is installed', () => {
    expect(
      pickChromiumBrowser({
        platform: 'linux',
        homedir: () => '/home/ada',
        env: { PATH: '/usr/bin' },
        exists: () => false
      })
    ).toBeUndefined()
  })
})

describe('installChromiumExtension', () => {
  const linuxChrome = posix.join('/usr/bin', 'google-chrome')
  const linuxExt = '/repo/extensions/chromium'
  const linuxManifest = posix.join(linuxExt, 'manifest.json')

  it('opens chrome://extensions and reveals the folder', async () => {
    const { spawn, calls } = spawnRecorder()
    const reveal = vi.fn(async () => '')
    await expect(
      installChromiumExtension({
        extensionDir: linuxExt,
        reveal,
        platform: 'linux',
        homedir: () => '/home/ada',
        env: { PATH: '/usr/bin' },
        exists: existsIn(linuxManifest, linuxChrome),
        spawn
      })
    ).resolves.toEqual({
      ok: true,
      openedExtensionsPage: true,
      revealed: true,
      browser: 'Google Chrome'
    })
    expect(calls).toEqual([{ command: linuxChrome, args: [CHROMIUM_EXTENSIONS_PAGE] }])
    expect(reveal).toHaveBeenCalledWith(linuxExt)
  })

  it('refuses when the unpacked folder has no manifest', async () => {
    const spawn = vi.fn(() => ({ unref: vi.fn() }))
    const reveal = vi.fn(async () => '')
    await expect(
      installChromiumExtension({
        extensionDir: linuxExt,
        reveal,
        platform: 'linux',
        homedir: () => '/home/ada',
        env: { PATH: '/usr/bin' },
        exists: existsIn(linuxChrome),
        spawn
      })
    ).resolves.toEqual({ ok: false, error: 'missing_extension' })
    expect(spawn).not.toHaveBeenCalled()
    expect(reveal).not.toHaveBeenCalled()
  })

  it('still reveals the folder when spawn throws', async () => {
    const reveal = vi.fn(async () => '')
    await expect(
      installChromiumExtension({
        extensionDir: linuxExt,
        reveal,
        platform: 'linux',
        homedir: () => '/home/ada',
        env: { PATH: '/usr/bin' },
        exists: existsIn(linuxManifest, linuxChrome),
        spawn: () => {
          throw new Error('spawn ENOENT')
        }
      })
    ).resolves.toEqual({
      ok: true,
      openedExtensionsPage: false,
      revealed: true,
      browser: 'Google Chrome'
    })
    expect(reveal).toHaveBeenCalledWith(linuxExt)
  })

  it('reveals the folder when PATH is empty and no Chromium is installed', async () => {
    const reveal = vi.fn(async () => '')
    const spawn = vi.fn(() => ({ unref: vi.fn() }))
    await expect(
      installChromiumExtension({
        extensionDir: linuxExt,
        reveal,
        platform: 'linux',
        homedir: () => '/home/ada',
        env: { PATH: '' },
        exists: existsIn(linuxManifest),
        spawn
      })
    ).resolves.toEqual({
      ok: true,
      openedExtensionsPage: false,
      revealed: true,
      browser: undefined
    })
    expect(spawn).not.toHaveBeenCalled()
    expect(reveal).toHaveBeenCalledWith(linuxExt)
  })

  it('reports reveal_failed when no browser opened and the folder would not open', async () => {
    await expect(
      installChromiumExtension({
        extensionDir: linuxExt,
        reveal: async () => 'Failed to open path',
        platform: 'linux',
        homedir: () => '/home/ada',
        env: { PATH: '' },
        exists: existsIn(linuxManifest),
        spawn: () => ({ unref: vi.fn() })
      })
    ).resolves.toEqual({
      ok: false,
      error: 'reveal_failed',
      detail: 'Failed to open path'
    })
  })

  it('treats a spawn success plus a failed reveal as a partial success', async () => {
    const { spawn } = spawnRecorder()
    await expect(
      installChromiumExtension({
        extensionDir: linuxExt,
        reveal: async () => 'Failed to open path',
        platform: 'linux',
        homedir: () => '/home/ada',
        env: { PATH: '/usr/bin' },
        exists: existsIn(linuxManifest, linuxChrome),
        spawn
      })
    ).resolves.toEqual({
      ok: true,
      openedExtensionsPage: true,
      revealed: false,
      browser: 'Google Chrome'
    })
  })
})
