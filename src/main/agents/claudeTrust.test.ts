import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CLAUDE_CONFIG_FILE,
  ensureClaudeWorkspaceTrust,
  trustKeysFor,
  TRUST_KEY,
  type ClaudeTrustDeps
} from './claudeTrust'

/**
 * A throwaway HOME with a `.claude.json` in it. Everything here runs against a
 * real file: the whole point of the module is that it round-trips a config it
 * did not write, and a mocked fs would prove nothing about that.
 */
let home: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'vertragus-trust-'))
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
})

function configPath(): string {
  return join(home, CLAUDE_CONFIG_FILE)
}

function writeConfig(value: unknown): void {
  writeFileSync(configPath(), typeof value === 'string' ? value : JSON.stringify(value, null, 2))
}

function readConfig(): Record<string, unknown> {
  return JSON.parse(readFileSync(configPath(), 'utf8')) as Record<string, unknown>
}

/** Deps pinned to the temp HOME, with realpath off unless a test wants it. */
function deps(overrides: ClaudeTrustDeps = {}): ClaudeTrustDeps {
  return {
    homeDir: () => home,
    realPath: (path: string) => path,
    warn: () => undefined,
    ...overrides
  }
}

/** The real file on this machine keys projects by an absolute native path. */
const REPO = process.platform === 'win32' ? 'C:\\git\\vertragus' : '/git/vertragus'

function projects(): Record<string, Record<string, unknown>> {
  return readConfig().projects as Record<string, Record<string, unknown>>
}

describe('trustKeysFor', () => {
  it('covers the slash spellings Claude Code actually stores', () => {
    const keys = trustKeysFor(REPO)
    expect(keys).toContain(REPO.replace(/\\/g, '/'))
    if (process.platform === 'win32') expect(keys).toContain('C:\\git\\vertragus')
  })

  it('adds the canonical on-disk spelling when realpath disagrees', () => {
    const keys = trustKeysFor(REPO, () => `${REPO}-real`)
    expect(keys).toContain(`${REPO}-real`.replace(/\\/g, '/'))
  })

  it('survives a directory that does not exist yet', () => {
    const keys = trustKeysFor(REPO, () => {
      throw new Error('ENOENT')
    })
    expect(keys.length).toBeGreaterThan(0)
  })
})

describe('ensureClaudeWorkspaceTrust', () => {
  it('adds the trust flag and leaves every other project untouched', () => {
    writeConfig({
      numStartups: 41,
      projects: {
        '/other/repo': { [TRUST_KEY]: false, lastCost: 12.5, mcpServers: { a: { url: 'x' } } }
      },
      oauthAccount: { emailAddress: 'someone@example.com' }
    })

    const result = ensureClaudeWorkspaceTrust(REPO, deps())

    expect(result.outcome).toBe('granted')
    for (const key of result.keys) expect(projects()[key]?.[TRUST_KEY]).toBe(true)
    // The neighbour keeps its own (false!) answer and all of its state.
    expect(projects()['/other/repo']).toEqual({
      [TRUST_KEY]: false,
      lastCost: 12.5,
      mcpServers: { a: { url: 'x' } }
    })
    expect(readConfig().numStartups).toBe(41)
    expect(readConfig().oauthAccount).toEqual({ emailAddress: 'someone@example.com' })
  })

  it('only sets the one key on an existing entry, keeping its history', () => {
    const key = REPO.replace(/\\/g, '/')
    writeConfig({
      projects: { [key]: { lastSessionId: 'abc', allowedTools: ['Bash'], lastCost: 3 } }
    })

    expect(ensureClaudeWorkspaceTrust(REPO, deps()).outcome).toBe('granted')
    expect(projects()[key]).toEqual({
      lastSessionId: 'abc',
      allowedTools: ['Bash'],
      lastCost: 3,
      [TRUST_KEY]: true
    })
  })

  it('is idempotent — a second call does not rewrite the file', () => {
    writeConfig({ projects: {} })
    expect(ensureClaudeWorkspaceTrust(REPO, deps()).outcome).toBe('granted')

    const writeFile = vi.fn()
    const again = ensureClaudeWorkspaceTrust(REPO, deps({ writeFile }))
    expect(again.outcome).toBe('already-trusted')
    // Not rewriting matters: a running Claude may be writing this file too.
    expect(writeFile).not.toHaveBeenCalled()
  })

  it('creates the projects table when the config has none yet', () => {
    writeConfig({ numStartups: 1 })
    expect(ensureClaudeWorkspaceTrust(REPO, deps()).outcome).toBe('granted')
    expect(Object.values(projects()).every((entry) => entry[TRUST_KEY] === true)).toBe(true)
  })

  it('writes atomically and leaves no temp file behind', () => {
    writeConfig({ projects: {} })
    ensureClaudeWorkspaceTrust(REPO, deps({ tempSuffix: () => 'fixed' }))
    expect(readdirSync(home)).toEqual([CLAUDE_CONFIG_FILE])
  })

  it('never invents a config for a machine where Claude has not run', () => {
    const warn = vi.fn()
    const result = ensureClaudeWorkspaceTrust(REPO, deps({ warn }))
    expect(result.outcome).toBe('skipped')
    expect(result.reason).toBe('config unreadable')
    expect(readdirSync(home)).toEqual([])
    expect(warn).toHaveBeenCalled()
  })

  it('refuses to touch a config it cannot parse', () => {
    writeConfig('{ this is not json')
    const warn = vi.fn()

    expect(ensureClaudeWorkspaceTrust(REPO, deps({ warn })).reason).toBe('config not json')
    // Byte-for-byte unchanged — a broken file is still the user's file.
    expect(readFileSync(configPath(), 'utf8')).toBe('{ this is not json')
    expect(warn).toHaveBeenCalled()
  })

  it('refuses a config whose projects table is not an object', () => {
    writeConfig({ projects: ['/repo'] })
    const warn = vi.fn()
    expect(ensureClaudeWorkspaceTrust(REPO, deps({ warn })).reason).toBe('projects not an object')
    expect(readConfig().projects).toEqual(['/repo'])
    expect(warn).toHaveBeenCalled()
  })

  it('steps around a single malformed project entry instead of giving up', () => {
    const key = REPO.replace(/\\/g, '/')
    writeConfig({ projects: { [key]: 'trusted, honest' } })
    const warn = vi.fn()

    const result = ensureClaudeWorkspaceTrust(REPO, deps({ warn }))
    expect(projects()[key]).toBe('trusted, honest')
    // The other spellings still get their entry, so the launch may be covered.
    if (result.outcome === 'granted') {
      expect(result.keys.some((other) => other !== key)).toBe(true)
    }
    expect(warn).toHaveBeenCalled()
  })

  it('reports a failed write instead of throwing into the launch', () => {
    writeConfig({ projects: {} })
    const warn = vi.fn()
    const result = ensureClaudeWorkspaceTrust(
      REPO,
      deps({
        warn,
        writeFile: () => {
          throw new Error('EPERM')
        }
      })
    )
    expect(result).toMatchObject({ outcome: 'skipped', reason: 'write failed' })
    expect(warn).toHaveBeenCalled()
  })

  it('does nothing for an empty directory', () => {
    expect(ensureClaudeWorkspaceTrust('   ', deps()).outcome).toBe('skipped')
  })
})

/**
 * Round-trip guard against a REAL `~/.claude.json` when this machine has one.
 * Fixtures prove the logic; only the genuine file — 56 KB of caches, MCP
 * servers, ten projects and a dozen shapes we never anticipated — proves that
 * writing it back does not lose anything. Skipped wherever the file is absent.
 */
const realConfig = join(homedir(), '.claude.json')
const canRun = existsSync(realConfig)

describe.skipIf(!canRun)('ensureClaudeWorkspaceTrust against the real config', () => {
  it('adds only the trust keys and round-trips everything else byte for byte', () => {
    const home = mkdtempSync(join(tmpdir(), 'vertragus-trust-real-'))
    try {
      copyFileSync(realConfig, join(home, '.claude.json'))
      const read = (): Record<string, unknown> =>
        JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8')) as Record<string, unknown>

      const before = read()
      const target = process.platform === 'win32' ? 'C:\\git\\vertragus-test' : '/git/vertragus-test'
      const result = ensureClaudeWorkspaceTrust(target, { homeDir: () => home })
      expect(['granted', 'already-trusted']).toContain(result.outcome)

      const after = read()
      const projectsOf = (config: Record<string, unknown>): Record<string, unknown> =>
        (config.projects ?? {}) as Record<string, unknown>

      // Nothing outside `projects` may move.
      expect({ ...after, projects: null }).toEqual({ ...before, projects: null })
      // No project may vanish, and none may change except into `trusted`.
      for (const [key, entry] of Object.entries(projectsOf(before))) {
        const now = projectsOf(after)[key]
        if (result.keys.includes(key)) {
          expect(now).toEqual({ ...(entry as object), hasTrustDialogAccepted: true })
        } else {
          expect(now).toEqual(entry)
        }
      }
      // Anything new is a trust key of ours and carries nothing else.
      for (const key of Object.keys(projectsOf(after))) {
        if (key in projectsOf(before)) continue
        expect(result.keys).toContain(key)
        expect(projectsOf(after)[key]).toEqual({ hasTrustDialogAccepted: true })
      }

      expect(ensureClaudeWorkspaceTrust(target, { homeDir: () => home }).outcome).toBe(
        'already-trusted'
      )
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})
