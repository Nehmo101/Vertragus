/**
 * The integrity guard for the Pi wrap exit.
 *
 * The overlay is gone: Play starts the slot's native CLI. That contract
 * rots silently — a production dep sneaks back, `piHarnessEnabled` returns
 * as a setting, asarUnpack grows Pi trees again, `isPtyOnly` grows a wrap
 * bypass so Ollama pretends to speak MCP. None of that fails a unit test
 * of argv, so this file checks the FILES:
 *
 *   1. package.json has none of the three Pi package names.
 *   2. overlay source files and the Pi-only Dependabot file are absent.
 *   3. src/scripts do not reintroduce `piHarnessEnabled`, `harness: 'pi'`,
 *      or imports of `agents/piHarness`.
 *   4. electron-builder.yml unpacks node-pty only — no Pi / Photon /
 *      keyring / typebox / jiti trees.
 *   5. host wins stay: default `cliSurface` is `session`; `isPtyOnly` is
 *      `mcp.kind === 'none'` with no wrap bypass; first-turn hold still
 *      calls `waitForSession`.
 *
 * Self-checks at the bottom keep the scanners honest: a regex that silently
 * stops matching must fail the suite, not green it.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const PACKAGE_JSON = join(repoRoot, 'package.json')
const DEPENDABOT = join(repoRoot, '.github', 'dependabot.yml')
const ELECTRON_BUILDER = join(repoRoot, 'electron-builder.yml')
const WORKSPACE = join(repoRoot, 'src', 'main', 'workspace', 'Workspace.ts')
const CLI_SURFACE = join(repoRoot, 'src', 'shared', 'cliSurface.ts')
const THIS_FILE = join(repoRoot, 'scripts', 'piExitGuard.test.ts')

const FORBIDDEN_PACKAGES = [
  '@earendil-works/pi-coding-agent',
  'pi-mcp-adapter',
  '@mariozechner/pi-coding-agent'
] as const

const GONE_FILES = [
  'src/main/agents/piHarness.ts',
  'src/main/agents/piHarness.test.ts',
  'src/main/piPlaySmoke.ts',
  'src/main/piPlaySmoke.test.ts',
  'scripts/pi-play-smoke.mjs',
  'scripts/piPlaySmoke.test.ts',
  'scripts/piHarnessPin.test.ts',
  'tests/integration/piHarnessMcp.integration.test.ts',
  '.github/dependabot.yml'
] as const

const PI_UNPACK_MARKERS = [
  '@earendil-works/**',
  '@mariozechner/**',
  '@silvia-odwyer/photon-node',
  'pi-mcp-adapter/**',
  '@napi-rs/**',
  'typebox/**',
  'jiti/**'
] as const

const SKIP_DIRS = new Set(['node_modules', '.git', 'out', 'dist', 'release', 'coverage'])

function walk(dir: string, keep: (name: string) => boolean, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(join(dir, entry.name), keep, acc)
      continue
    }
    if (entry.isFile() && keep(entry.name)) acc.push(join(dir, entry.name))
  }
  return acc
}

function productionSources(): string[] {
  return [
    ...walk(join(repoRoot, 'src'), (name) => /\.(ts|tsx|js|mjs|cjs)$/.test(name)),
    ...walk(join(repoRoot, 'scripts'), (name) => /\.(ts|js|mjs)$/.test(name))
  ].filter((path) => path !== THIS_FILE)
}

describe('package.json has no Pi packages', () => {
  const pkg = JSON.parse(readFileSync(PACKAGE_JSON, 'utf8')) as {
    dependencies?: Record<string, string>
    devDependencies?: Record<string, string>
  }
  const names = [...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})]

  it('does not declare the wrap CLI, the adapter, or the deprecated mariozechner name', () => {
    for (const name of FORBIDDEN_PACKAGES) {
      expect(names, name).not.toContain(name)
    }
  })
})

describe('overlay files are gone', () => {
  it('does not keep Pi harness, Play smoke, the old pin, or Pi-only Dependabot', () => {
    for (const rel of GONE_FILES) {
      expect(existsSync(join(repoRoot, rel)), rel).toBe(false)
    }
  })
})

describe('src and scripts do not reintroduce the overlay', () => {
  const files = productionSources()
  const joined = files.map((file) => `${file}\n${readFileSync(file, 'utf8')}`).join('\n')

  it('walked the tree', () => {
    expect(files.length, 'source walk found no files').toBeGreaterThan(50)
  })

  it('has no piHarnessEnabled setting', () => {
    expect(joined).not.toMatch(/piHarnessEnabled/)
  })

  it("has no harness: 'pi' spawn overlay", () => {
    expect(joined).not.toMatch(/harness:\s*'pi'/)
  })

  it('does not import agents/piHarness', () => {
    expect(joined).not.toMatch(/agents\/piHarness/)
    expect(joined).not.toMatch(/from ['"]\.\/piHarness['"]/)
  })

  it('does not name the forbidden packages', () => {
    for (const name of FORBIDDEN_PACKAGES) {
      expect(joined, name).not.toContain(name)
    }
  })
})

describe('electron-builder asarUnpack', () => {
  const source = readFileSync(ELECTRON_BUILDER, 'utf8')

  it('still unpacks node-pty so agent spawn works from asar', () => {
    expect(source).toMatch(/asarUnpack:/)
    expect(source).toContain('@lydell/node-pty')
  })

  it('does not unpack Pi / Photon / keyring / typebox / jiti trees', () => {
    for (const marker of PI_UNPACK_MARKERS) {
      expect(source, marker).not.toContain(marker)
    }
  })

  it('covers the unpacked node-pty tree in x64ArchFiles', () => {
    const rule = source.match(/x64ArchFiles:\s*'([^']+)'/)?.[1]
    expect(rule, 'x64ArchFiles vanished').toBeTruthy()
    expect(rule).toMatch(/node-pty/)
  })

  it('merges ASARs now that the Pi unpack overflow is gone', () => {
    expect(source).toMatch(/mergeASARs:\s*true/)
  })
})

describe('host wins stay native', () => {
  const workspace = readFileSync(WORKSPACE, 'utf8')
  const surface = readFileSync(CLI_SURFACE, 'utf8')

  it('defaults cliSurface to session', () => {
    expect(surface).toMatch(/export const DEFAULT_CLI_SURFACE:\s*CliSurface\s*=\s*'session'/)
    expect(surface).not.toMatch(/piHarness/)
  })

  it('isPtyOnly is mcp.kind === none with no wrap bypass', () => {
    const fn = workspace.match(
      /private isPtyOnly\(providerId: string\): boolean \{([\s\S]*?)\n {2}\}/
    )?.[1]
    expect(fn, 'isPtyOnly vanished').toBeTruthy()
    expect(fn).toMatch(/mcp\.kind === 'none'/)
    expect(fn).not.toMatch(/piHarness|harness|wrap/i)
  })

  it('first-turn hold still waits on waitForSession', () => {
    expect(workspace).toMatch(/private waitForMcpSession\(/)
    expect(workspace).toMatch(/waitForSession/)
    const wait = workspace.match(
      /private waitForMcpSession\([\s\S]*?\n {2}\}/
    )?.[0]
    expect(wait, 'waitForMcpSession vanished').toBeTruthy()
    expect(wait).not.toMatch(/piHarness/)
    expect(workspace).toMatch(/private async seedWhenMcpReady\(/)
    expect(workspace).toMatch(/waitForMcpSession\(/)
  })
})

describe('the scanners themselves', () => {
  const pkg = JSON.parse(readFileSync(PACKAGE_JSON, 'utf8')) as {
    dependencies: Record<string, string>
  }
  const builder = readFileSync(ELECTRON_BUILDER, 'utf8')
  const workspace = readFileSync(WORKSPACE, 'utf8')
  const surface = readFileSync(CLI_SURFACE, 'utf8')
  const files = productionSources()

  it('still reads package.json dependencies', () => {
    expect(Object.keys(pkg.dependencies).length, 'dependencies vanished').toBeGreaterThan(3)
    expect(pkg.dependencies['@lydell/node-pty'], 'node-pty pin went silent').toMatch(/^\^?\d/)
  })

  it('still sees asarUnpack and x64ArchFiles in electron-builder.yml', () => {
    expect(builder.indexOf('asarUnpack:'), 'asarUnpack key vanished').toBeGreaterThanOrEqual(0)
    expect(builder.match(/x64ArchFiles:\s*'([^']+)'/)?.[1], 'x64ArchFiles regex went silent').toBeTruthy()
    expect(builder).toMatch(/mergeASARs:\s*(true|false)/)
  })

  it('still matches isPtyOnly and waitForMcpSession in Workspace.ts', () => {
    expect(workspace.match(/private isPtyOnly\(providerId: string\): boolean \{/), 'isPtyOnly regex went silent').toBeTruthy()
    expect(
      workspace.match(/private waitForMcpSession\(/),
      'waitForMcpSession regex went silent'
    ).toBeTruthy()
  })

  it('still matches DEFAULT_CLI_SURFACE', () => {
    expect(
      surface.match(/export const DEFAULT_CLI_SURFACE:\s*CliSurface\s*=\s*'session'/),
      'DEFAULT_CLI_SURFACE regex went silent'
    ).toBeTruthy()
  })

  it('source walk still finds spawn and this guard', () => {
    expect(files.some((file) => file.endsWith(`${join('agents', 'spawn.ts')}`))).toBe(true)
    expect(existsSync(THIS_FILE)).toBe(true)
    expect(existsSync(DEPENDABOT)).toBe(false)
  })

  it('forbidden-package list is the three names this exit deleted', () => {
    expect(FORBIDDEN_PACKAGES).toEqual([
      '@earendil-works/pi-coding-agent',
      'pi-mcp-adapter',
      '@mariozechner/pi-coding-agent'
    ])
    expect(GONE_FILES.length, 'gone-file list went empty').toBeGreaterThan(5)
    expect(PI_UNPACK_MARKERS.length, 'unpack-marker list went empty').toBeGreaterThan(3)
  })
})
