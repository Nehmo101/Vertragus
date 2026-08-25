/**
 * The integrity guard for the Pi lockfile pin.
 *
 * The wrap is not a seventh provider: Pi is a spawn overlay whose CLI and
 * MCP adapter live in package.json so Dependabot can open review PRs. That
 * contract rots silently — a third npm package allowed in, automerge turned
 * on, asarUnpack dropped so photon's WASM cannot load, the adapter name
 * drifting from the Dependabot allow-list. None of that fails a unit test
 * of argv, so this file checks the FILES:
 *
 *   1. package.json pins exactly those two production deps by name.
 *   2. .github/dependabot.yml allow-lists only those names, grouped, with
 *      no automerge.
 *   3. electron-builder.yml unpacks the trees native/WASM load from, covers
 *      all of node_modules in mac.x64ArchFiles (unscoped addons like koffi),
 *      and keeps mergeASARs off (Pi unpack trees overflow the asar glob).
 *   4. The installed adapter imports the same CLI package we spawn (a
 *      name mismatch is process.exit(1) at extension load).
 *
 * Self-checks at the bottom keep the scanners honest: a regex that silently
 * stops matching must fail the suite, not green it.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  PI_CODING_AGENT_PACKAGE,
  PI_MCP_ADAPTER_PACKAGE
} from '@main/agents/piHarness'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const PACKAGE_JSON = join(repoRoot, 'package.json')
const DEPENDABOT = join(repoRoot, '.github', 'dependabot.yml')
const ELECTRON_BUILDER = join(repoRoot, 'electron-builder.yml')

const PINNED = [PI_CODING_AGENT_PACKAGE, PI_MCP_ADAPTER_PACKAGE] as const

function quotedName(name: string): string {
  return name.startsWith('@') ? `'${name}'` : name
}

function adapterPackageDir(): string {
  return join(repoRoot, 'node_modules', PI_MCP_ADAPTER_PACKAGE)
}

function walkAdapterSources(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      walkAdapterSources(path, acc)
      continue
    }
    if (/\.(ts|js|mjs|cjs|mts|cts)$/.test(entry.name)) acc.push(path)
  }
  return acc
}

describe('package.json pins', () => {
  const pkg = JSON.parse(readFileSync(PACKAGE_JSON, 'utf8')) as {
    dependencies?: Record<string, string>
  }
  const deps = pkg.dependencies ?? {}

  it('declares both Pi packages as production dependencies', () => {
    expect(deps[PI_CODING_AGENT_PACKAGE], PI_CODING_AGENT_PACKAGE).toMatch(/^\^?\d+\.\d+\.\d+/)
    expect(deps[PI_MCP_ADAPTER_PACKAGE], PI_MCP_ADAPTER_PACKAGE).toMatch(/^\^?\d+\.\d+\.\d+/)
  })

  it('does not add Pi as a provider preset by sneaking a third name into the pin', () => {
    expect(PINNED).toHaveLength(2)
    expect(PINNED).toEqual(['@earendil-works/pi-coding-agent', 'pi-mcp-adapter'])
    expect(Object.keys(deps)).not.toContain('@mariozechner/pi-coding-agent')
  })
})

describe('Dependabot allow-list', () => {
  const source = readFileSync(DEPENDABOT, 'utf8')

  it('exists where GitHub looks for it', () => {
    expect(existsSync(DEPENDABOT)).toBe(true)
  })

  it('is npm at the repo root, weekly, no automerge', () => {
    expect(source).toMatch(/package-ecosystem:\s*npm/)
    expect(source).toMatch(/directory:\s*\/\s*$/m)
    expect(source).toMatch(/interval:\s*weekly/)
    expect(source).not.toMatch(/automerge:\s*true/)
  })

  it('allow-lists only the two Pi lockfile pins, grouped', () => {
    const allow = [...source.matchAll(/dependency-name:\s*['"]?([^'"\n]+?)['"]?\s*$/gm)].map(
      (match) => match[1]!.trim()
    )
    expect(allow.sort()).toEqual([...PINNED].sort())
    expect(source).toMatch(/groups:\s*\n\s*pi-harness:/)
    for (const name of PINNED) {
      expect(source).toContain(quotedName(name))
    }
  })
})

describe('electron-builder asarUnpack', () => {
  const source = readFileSync(ELECTRON_BUILDER, 'utf8')

  it('unpacks the Pi CLI, photon, the adapter, and native keyring', () => {
    expect(source).toMatch(/asarUnpack:/)
    expect(source).toContain('@earendil-works/**')
    expect(source).toContain('@mariozechner/**')
    expect(source).toContain('@silvia-odwyer/photon-node')
    expect(source).toContain('pi-mcp-adapter/**')
    expect(source).toContain('@napi-rs/**')
  })

  it('covers all of node_modules in x64ArchFiles, including unscoped addons like koffi', () => {
    const rule = source.match(/x64ArchFiles:\s*'([^']+)'/)?.[1]
    expect(rule, 'x64ArchFiles vanished').toBe('**/node_modules/**')
  })

  it('does not merge ASARs: Pi unpack trees overflow minimatch brace globs', () => {
    expect(source).toMatch(/mergeASARs:\s*false/)
  })
})

describe('adapter imports the lockfile CLI package', () => {
  it('pi-mcp-adapter loads the same @earendil-works package we spawn', () => {
    const dir = adapterPackageDir()
    expect(existsSync(join(dir, 'package.json')), 'pi-mcp-adapter missing from node_modules').toBe(
      true
    )
    const files = walkAdapterSources(dir)
    expect(files.length, 'adapter source walk found no JS/TS files').toBeGreaterThan(0)
    const source = files.map((file) => readFileSync(file, 'utf8')).join('\n')
    expect(source.includes(PI_CODING_AGENT_PACKAGE)).toBe(true)
    expect(source).not.toMatch(/@mariozechner\/pi-coding-agent/)
  })
})

describe('the scanners themselves', () => {
  const dependabot = readFileSync(DEPENDABOT, 'utf8')
  const builder = readFileSync(ELECTRON_BUILDER, 'utf8')

  it('still matches the allow-list lines it polices', () => {
    const allow = [...dependabot.matchAll(/dependency-name:\s*['"]?([^'"\n]+?)['"]?\s*$/gm)]
    expect(allow.length, 'Dependabot allow-list regex went silent').toBe(2)
  })

  it('still sees asarUnpack patterns in electron-builder.yml', () => {
    expect(builder.indexOf('asarUnpack:'), 'asarUnpack key vanished').toBeGreaterThanOrEqual(0)
    expect(builder).toMatch(/node_modules\/@earendil-works/)
    expect(builder).toMatch(/node_modules\/@mariozechner/)
  })

  it('still matches the adapter import it polices', () => {
    const files = walkAdapterSources(adapterPackageDir())
    expect(files.length, 'adapter source walk went silent').toBeGreaterThan(0)
    const source = files.map((file) => readFileSync(file, 'utf8')).join('\n')
    expect(source.includes(PI_CODING_AGENT_PACKAGE), 'adapter import scan went silent').toBe(true)
  })

  it('still matches the x64ArchFiles line it polices', () => {
    expect(builder.match(/x64ArchFiles:\s*'([^']+)'/)?.[1], 'x64ArchFiles regex went silent').toBe(
      '**/node_modules/**'
    )
  })

  it('still sees mergeASARs: false', () => {
    expect(builder).toMatch(/mergeASARs:\s*false/)
  })

  it('pins constants that match the files', () => {
    const pkg = JSON.parse(readFileSync(PACKAGE_JSON, 'utf8')) as {
      dependencies: Record<string, string>
    }
    expect(Object.keys(pkg.dependencies)).toEqual(
      expect.arrayContaining([PI_CODING_AGENT_PACKAGE, PI_MCP_ADAPTER_PACKAGE])
    )
  })
})
