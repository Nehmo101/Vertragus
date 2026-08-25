/**
 * Settings "Install Chromium extension": open chrome://extensions in a
 * Chromium-family browser and reveal the unpacked folder.
 *
 * Chromium will not let Electron silently load an unpacked MV3 extension into
 * the user's existing profile. `--load-extension` is ignored when a browser
 * is already running; the Web Store is out of scope. The honest action is
 * therefore: open the extensions page, open the folder, and let the user
 * click Developer mode → Load unpacked.
 *
 * Pure on purpose — unit-tested without Electron.
 */
import { spawn as spawnProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir as osHomedir } from 'node:os'
import { posix, win32 } from 'node:path'
import type { BrowserExtensionInstallResult } from '@shared/browserExtension'

export const CHROMIUM_EXTENSIONS_PAGE = 'chrome://extensions'

export type ChromiumBrowserId = 'chrome' | 'chromium' | 'brave' | 'edge' | 'vivaldi'

export interface PickedChromiumBrowser {
  id: ChromiumBrowserId
  label: string
  command: string
  args: string[]
}

export interface SpawnHandle {
  unref(): void
}

export type SpawnChromium = (
  command: string,
  args: readonly string[],
  options: { detached: true; stdio: 'ignore' }
) => SpawnHandle

export interface PickChromiumBrowserInput {
  platform: NodeJS.Platform
  homedir: () => string
  env: NodeJS.ProcessEnv
  exists: (path: string) => boolean
}

export interface InstallChromiumExtensionInput {
  extensionDir: string
  reveal: (path: string) => Promise<string>
  platform?: NodeJS.Platform
  homedir?: () => string
  env?: NodeJS.ProcessEnv
  exists?: (path: string) => boolean
  spawn?: SpawnChromium
}

interface BrowserSpec {
  id: ChromiumBrowserId
  label: string
  /** PATH basenames (Windows also tries .exe / .cmd). */
  names: string[]
  linuxPaths: string[]
  darwinApp: string
  winRel: string[][]
}

const BROWSERS: readonly BrowserSpec[] = [
  {
    id: 'chrome',
    label: 'Google Chrome',
    names: ['google-chrome-stable', 'google-chrome', 'chrome'],
    linuxPaths: [
      '/opt/google/chrome/google-chrome',
      '/opt/google/chrome/chrome',
      '/usr/bin/google-chrome-stable',
      '/usr/bin/google-chrome'
    ],
    darwinApp: 'Google Chrome.app',
    winRel: [['Google', 'Chrome', 'Application', 'chrome.exe']]
  },
  {
    id: 'chromium',
    label: 'Chromium',
    names: ['chromium', 'chromium-browser'],
    linuxPaths: ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium'],
    darwinApp: 'Chromium.app',
    winRel: [['Chromium', 'Application', 'chrome.exe']]
  },
  {
    id: 'brave',
    label: 'Brave',
    names: ['brave-browser', 'brave'],
    linuxPaths: ['/usr/bin/brave-browser', '/opt/brave.com/brave/brave-browser'],
    darwinApp: 'Brave Browser.app',
    winRel: [['BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe']]
  },
  {
    id: 'edge',
    label: 'Microsoft Edge',
    names: ['microsoft-edge-stable', 'microsoft-edge', 'msedge'],
    linuxPaths: ['/usr/bin/microsoft-edge-stable', '/usr/bin/microsoft-edge', '/opt/microsoft/msedge/msedge'],
    darwinApp: 'Microsoft Edge.app',
    winRel: [['Microsoft', 'Edge', 'Application', 'msedge.exe']]
  },
  {
    id: 'vivaldi',
    label: 'Vivaldi',
    names: ['vivaldi'],
    linuxPaths: ['/usr/bin/vivaldi', '/opt/vivaldi/vivaldi'],
    darwinApp: 'Vivaldi.app',
    winRel: [['Vivaldi', 'Application', 'vivaldi.exe']]
  }
]

function pathApi(platform: NodeJS.Platform): typeof posix | typeof win32 {
  return platform === 'win32' ? win32 : posix
}

function pathDirs(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string[] {
  const value = env.PATH ?? env.Path ?? ''
  const sep = platform === 'win32' ? ';' : ':'
  return value.split(sep).filter(Boolean)
}

function commandOnPath(
  name: string,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  exists: (path: string) => boolean
): string | undefined {
  const pathMod = pathApi(platform)
  const exts = platform === 'win32' ? ['.exe', '.cmd', ''] : ['']
  for (const dir of pathDirs(platform, env)) {
    for (const ext of exts) {
      const candidate = pathMod.join(dir, `${name}${ext}`)
      if (exists(candidate)) return candidate
    }
  }
  return undefined
}

function firstExisting(candidates: readonly string[], exists: (path: string) => boolean): string | undefined {
  return candidates.find((candidate) => exists(candidate))
}

function windowsRoots(
  env: NodeJS.ProcessEnv,
  home: string,
  pathMod: typeof win32
): string[] {
  const programFiles = env.PROGRAMFILES ?? env.ProgramFiles ?? 'C:\\Program Files'
  const programFilesX86 =
    env['PROGRAMFILES(X86)'] ?? env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)'
  const localAppData =
    env.LOCALAPPDATA ?? env.LocalAppData ?? pathMod.join(home, 'AppData', 'Local')
  return [programFiles, programFilesX86, localAppData]
}

function windowsExecutables(spec: BrowserSpec, env: NodeJS.ProcessEnv, home: string): string[] {
  const pathMod = win32
  const roots = windowsRoots(env, home, pathMod)
  const found: string[] = []
  for (const rel of spec.winRel) {
    for (const root of roots) {
      found.push(pathMod.join(root, ...rel))
    }
  }
  return found
}

function darwinLaunch(
  bundle: string,
  executableName: string,
  exists: (path: string) => boolean
): { command: string; args: string[] } {
  const executable = posix.join(bundle, 'Contents', 'MacOS', executableName)
  if (exists(executable)) {
    return { command: executable, args: [CHROMIUM_EXTENSIONS_PAGE] }
  }
  return { command: '/usr/bin/open', args: ['-a', bundle, CHROMIUM_EXTENSIONS_PAGE] }
}

/**
 * First installed Chromium-family browser we can launch with
 * `chrome://extensions`. Preference: Chrome, Chromium, Brave, Edge, Vivaldi.
 */
export function pickChromiumBrowser(input: PickChromiumBrowserInput): PickedChromiumBrowser | undefined {
  const { platform, env, exists } = input
  const home = input.homedir()

  for (const spec of BROWSERS) {
    if (platform === 'darwin') {
      const roots = ['/Applications', posix.join(home, 'Applications')]
      for (const root of roots) {
        const bundle = posix.join(root, spec.darwinApp)
        if (!exists(bundle)) continue
        const executableName = spec.darwinApp.replace(/\.app$/, '')
        const launch = darwinLaunch(bundle, executableName, exists)
        return { id: spec.id, label: spec.label, ...launch }
      }
      continue
    }

    if (platform === 'win32') {
      const fromPath = spec.names
        .map((name) => commandOnPath(name, platform, env, exists))
        .find((found): found is string => found !== undefined)
      const fromDisk = firstExisting(windowsExecutables(spec, env, home), exists)
      const command = fromPath ?? fromDisk
      if (!command) continue
      return { id: spec.id, label: spec.label, command, args: [CHROMIUM_EXTENSIONS_PAGE] }
    }

    const fromPath = spec.names
      .map((name) => commandOnPath(name, platform, env, exists))
      .find((found): found is string => found !== undefined)
    const fromDisk = firstExisting(spec.linuxPaths, exists)
    const command = fromPath ?? fromDisk
    if (!command) continue
    return { id: spec.id, label: spec.label, command, args: [CHROMIUM_EXTENSIONS_PAGE] }
  }
  return undefined
}

function defaultSpawn(
  command: string,
  args: readonly string[],
  options: { detached: true; stdio: 'ignore' }
): SpawnHandle {
  return spawnProcess(command, [...args], options)
}

function openExtensionsPage(browser: PickedChromiumBrowser, spawn: SpawnChromium): boolean {
  try {
    const child = spawn(browser.command, browser.args, { detached: true, stdio: 'ignore' })
    child.unref()
    return true
  } catch {
    return false
  }
}

export async function installChromiumExtension(
  input: InstallChromiumExtensionInput
): Promise<BrowserExtensionInstallResult> {
  const exists = input.exists ?? existsSync
  const extensionDir = input.extensionDir
  const manifest = pathApi(input.platform ?? process.platform).join(extensionDir, 'manifest.json')
  if (!exists(manifest)) {
    return { ok: false, error: 'missing_extension' }
  }

  const browser = pickChromiumBrowser({
    platform: input.platform ?? process.platform,
    homedir: input.homedir ?? osHomedir,
    env: input.env ?? process.env,
    exists
  })
  const openedExtensionsPage = browser
    ? openExtensionsPage(browser, input.spawn ?? defaultSpawn)
    : false

  const revealError = await input.reveal(extensionDir)
  if (revealError && !openedExtensionsPage) {
    return { ok: false, error: 'reveal_failed', detail: revealError }
  }
  return {
    ok: true,
    openedExtensionsPage,
    revealed: !revealError,
    browser: browser?.label
  }
}
