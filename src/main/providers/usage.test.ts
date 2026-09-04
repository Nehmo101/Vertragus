import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { expandHome } from '@main/providers/discovery'
import type { UsageSource } from '@shared/schema/provider'
import {
  USAGE_FILE_MAX_BYTES,
  claudeProjectSlug,
  codexRolloutHeader,
  codexUsageFromRollout,
  grokContextUsage,
  grokEncodedCwd,
  readTokenUsage,
  resetUsageWarning,
  sameCwd,
  sumClaudeUsage,
  type UsageDeps,
  type UsageProbe
} from './usage'

const FIXTURES = join(__dirname, '__fixtures__')
const claudeJsonl = readFileSync(join(FIXTURES, 'claude-session-usage.jsonl'), 'utf8')
const codexJsonl = readFileSync(join(FIXTURES, 'codex-rollout-usage.jsonl'), 'utf8')
const grokSignals = readFileSync(join(FIXTURES, 'grok-signals.json'), 'utf8')
const grokUpdates = readFileSync(join(FIXTURES, 'grok-updates.jsonl'), 'utf8')
const grokSummary = readFileSync(join(FIXTURES, 'grok-summary.json'), 'utf8')

const WIN_CWD = 'C:\\Git\\Vertragus\\.vertragus\\worktrees\\2da4abcd'
const HOME = 'C:\\Users\\t'
const SESSION = 'agent-session'
const STARTED = Date.parse('2026-09-05T10:00:00.000Z')

const claudeSource: UsageSource = {
  kind: 'claude-jsonl',
  dir: '~/.claude/projects',
  sessionIdArg: '--session-id'
}
const codexSource: UsageSource = { kind: 'codex-rollout', dir: '~/.codex/sessions' }
const grokSource: UsageSource = {
  kind: 'grok-session',
  dir: '~/.grok/sessions',
  sessionIdArg: '--session-id'
}

function probe(source: UsageSource, overrides: Partial<UsageProbe> = {}): UsageProbe {
  return { source, cwd: WIN_CWD, sessionId: SESSION, startedAt: STARTED, ...overrides }
}

function dateKey(ms: number): string {
  const date = new Date(ms)
  return `${date.getFullYear()}/${String(date.getMonth() + 1).padStart(2, '0')}/${String(date.getDate()).padStart(2, '0')}`
}

function memDeps(files: Record<string, string>, dirs: Record<string, string[]> = {}): UsageDeps {
  return {
    async readFile(path) {
      if (path in files) return files[path]!
      const error = new Error(`ENOENT: ${path}`) as Error & { code: string }
      error.code = 'ENOENT'
      throw error
    },
    async readdir(path) {
      if (path in dirs) return dirs[path]!
      const error = new Error(`ENOENT: ${path}`) as Error & { code: string }
      error.code = 'ENOENT'
      throw error
    },
    async stat(path) {
      if (path in files) {
        const content = files[path]!
        return {
          size: Buffer.byteLength(content),
          mtimeMs: STARTED,
          isFile: () => true,
          isDirectory: () => false
        }
      }
      const error = new Error(`ENOENT: ${path}`) as Error & { code: string }
      error.code = 'ENOENT'
      throw error
    },
    homeDir: () => HOME,
    now: () => STARTED + 60_000,
    platform: 'win32'
  }
}

afterEach(() => {
  resetUsageWarning()
  vi.restoreAllMocks()
})

describe('claudeProjectSlug', () => {
  it('replaces every non-alphanumeric character without collapsing dashes', () => {
    expect(claudeProjectSlug(WIN_CWD)).toBe('C--Git-Vertragus--vertragus-worktrees-2da4abcd')
    expect(claudeProjectSlug('/home/user/proj')).toBe('-home-user-proj')
  })
})

describe('sumClaudeUsage', () => {
  it('dedupes by message.id (last wins), counts sidechain, skips torn lines', () => {
    expect(sumClaudeUsage(claudeJsonl)).toEqual({
      kind: 'consumption',
      input: 200,
      output: 39,
      cacheRead: 15,
      cacheWrite: 20,
      total: 274
    })
  })

  it('is undefined for zero assistant lines and never invents 0', () => {
    expect(sumClaudeUsage('{"type":"user","message":{"role":"user"}}\n')).toBeUndefined()
    expect(sumClaudeUsage('')).toBeUndefined()
  })

  it('sets total to the sum of the four recorded parts', () => {
    const usage = sumClaudeUsage(
      JSON.stringify({
        type: 'assistant',
        message: {
          id: 'm1',
          usage: {
            input_tokens: 1,
            output_tokens: 2,
            cache_read_input_tokens: 3,
            cache_creation_input_tokens: 4
          }
        }
      })
    )
    expect(usage).toEqual({
      kind: 'consumption',
      input: 1,
      output: 2,
      cacheRead: 3,
      cacheWrite: 4,
      total: 10
    })
  })
})

describe('readTokenUsage — claude-jsonl', () => {
  it('reads the exact pinned session path', async () => {
    const filePath = join(
      expandHome(claudeSource.dir, HOME),
      claudeProjectSlug(WIN_CWD),
      `${SESSION}.jsonl`
    )
    const seen: string[] = []
    const deps = memDeps({ [filePath]: claudeJsonl })
    const wrapped: UsageDeps = {
      ...deps,
      readFile: async (path) => {
        seen.push(path)
        return deps.readFile(path)
      }
    }
    const usage = await readTokenUsage(probe(claudeSource), wrapped)
    expect(seen).toEqual([filePath])
    expect(usage?.kind).toBe('consumption')
    expect(usage && usage.kind === 'consumption' ? usage.total : undefined).toBe(274)
  })

  it('returns undefined for a missing file', async () => {
    await expect(readTokenUsage(probe(claudeSource), memDeps({}))).resolves.toBeUndefined()
  })

  it('returns undefined when the file exceeds USAGE_FILE_MAX_BYTES', async () => {
    const filePath = join(
      expandHome(claudeSource.dir, HOME),
      claudeProjectSlug(WIN_CWD),
      `${SESSION}.jsonl`
    )
    const deps = memDeps({ [filePath]: claudeJsonl })
    const capped: UsageDeps = {
      ...deps,
      stat: async () => ({
        size: USAGE_FILE_MAX_BYTES + 1,
        mtimeMs: STARTED,
        isFile: () => true,
        isDirectory: () => false
      })
    }
    await expect(readTokenUsage(probe(claudeSource), capped)).resolves.toBeUndefined()
  })
})

describe('codex rollout helpers', () => {
  it('reads session_meta cwd/session_id/timestamp', () => {
    expect(codexRolloutHeader(codexJsonl)).toEqual({
      cwd: WIN_CWD,
      sessionId: 'codex-own-id',
      startedAt: Date.parse('2026-09-05T10:00:00.000Z')
    })
  })

  it('takes the last thread_token_usage and maps cache_write_input_tokens', () => {
    expect(codexUsageFromRollout(codexJsonl)).toEqual({
      kind: 'consumption',
      input: 400,
      output: 80,
      cacheRead: 50,
      cacheWrite: 15,
      total: 545
    })
  })
})

describe('readTokenUsage — codex-rollout', () => {
  function codexFiles(
    entries: Array<{ date: string; name: string; jsonl: string }>
  ): { files: Record<string, string>; dirs: Record<string, string[]> } {
    const root = expandHome(codexSource.dir, HOME)
    const files: Record<string, string> = {}
    const dirs: Record<string, string[]> = {}
    for (const entry of entries) {
      const dir = join(root, ...entry.date.split('/'))
      dirs[dir] = [...(dirs[dir] ?? []), entry.name]
      files[join(dir, entry.name)] = entry.jsonl
    }
    return { files, dirs }
  }

  it('matches by cwd (case-insensitive on win32) and start time; newest wins', async () => {
    const today = dateKey(STARTED)
    const older = codexJsonl.replace('2026-09-05T10:00:00.000Z', '2026-09-05T10:00:00.000Z')
    const newer = codexJsonl
      .replace('2026-09-05T10:00:00.000Z', '2026-09-05T10:00:30.000Z')
      .replace('"total_tokens":545', '"total_tokens":999')
    const { files, dirs } = codexFiles([
      { date: today, name: 'rollout-old.jsonl', jsonl: older },
      { date: today, name: 'rollout-new.jsonl', jsonl: newer }
    ])
    const usage = await readTokenUsage(probe(codexSource), memDeps(files, dirs))
    expect(usage && usage.kind === 'consumption' ? usage.total : undefined).toBe(999)
  })

  it('ignores a foreign cwd and a session older than startedAt - 60s', async () => {
    const today = dateKey(STARTED)
    const foreign = codexJsonl.replace(WIN_CWD.replace(/\\/g, '\\\\'), 'D:\\\\other')
    const tooOld = codexJsonl.replace('2026-09-05T10:00:00.000Z', '2026-09-04T00:00:00.000Z')
    const { files, dirs } = codexFiles([
      { date: today, name: 'rollout-foreign.jsonl', jsonl: foreign },
      { date: today, name: 'rollout-old.jsonl', jsonl: tooOld }
    ])
    await expect(readTokenUsage(probe(codexSource), memDeps(files, dirs))).resolves.toBeUndefined()
  })

  it('scans yesterday’s date dir', async () => {
    const yesterday = dateKey(STARTED - 86_400_000)
    const stamped = codexJsonl.replace(
      '2026-09-05T10:00:00.000Z',
      new Date(STARTED - 30_000).toISOString()
    )
    const { files, dirs } = codexFiles([
      { date: yesterday, name: 'rollout-y.jsonl', jsonl: stamped }
    ])
    const usage = await readTokenUsage(probe(codexSource), memDeps(files, dirs))
    expect(usage && usage.kind === 'consumption' ? usage.total : undefined).toBe(545)
  })
})

describe('grokEncodedCwd / grokContextUsage', () => {
  it('pins encodeURIComponent of the real Windows worktree path', () => {
    expect(grokEncodedCwd(WIN_CWD)).toBe(
      'C%3A%5CGit%5CVertragus%5C.vertragus%5Cworktrees%5C2da4abcd'
    )
    expect(grokEncodedCwd(WIN_CWD)).toBe(encodeURIComponent(WIN_CWD))
  })

  it('prefers signals.json and falls back to the last _meta.totalTokens', () => {
    expect(grokContextUsage({ signals: grokSignals, updates: grokUpdates })).toEqual({
      kind: 'context',
      used: 48_000,
      window: 131_072
    })
    expect(grokContextUsage({ updates: grokUpdates })).toEqual({
      kind: 'context',
      used: 24_000
    })
  })
})

describe('readTokenUsage — grok-session', () => {
  function grokDir(): string {
    return join(expandHome(grokSource.dir, HOME), grokEncodedCwd(WIN_CWD), SESSION)
  }

  it('yields kind context from signals.json', async () => {
    const dir = grokDir()
    const usage = await readTokenUsage(
      probe(grokSource),
      memDeps({
        [join(dir, 'summary.json')]: grokSummary,
        [join(dir, 'signals.json')]: grokSignals,
        [join(dir, 'updates.jsonl')]: grokUpdates
      })
    )
    expect(usage).toEqual({ kind: 'context', used: 48_000, window: 131_072 })
  })

  it('returns undefined when summary.json cwd mismatches', async () => {
    const dir = grokDir()
    const mismatch = JSON.stringify({ info: { cwd: 'D:\\other', id: SESSION } })
    await expect(
      readTokenUsage(
        probe(grokSource),
        memDeps({
          [join(dir, 'summary.json')]: mismatch,
          [join(dir, 'signals.json')]: grokSignals
        })
      )
    ).resolves.toBeUndefined()
  })
})

describe('sameCwd', () => {
  it('is case-insensitive on win32 and strips trailing separators', () => {
    expect(sameCwd(WIN_CWD, WIN_CWD.toLowerCase(), 'win32')).toBe(true)
    expect(sameCwd('/tmp/a', '/tmp/a/', 'linux')).toBe(true)
    expect(sameCwd('/tmp/a', '/tmp/b', 'linux')).toBe(false)
  })
})

describe('readTokenUsage fail-soft', () => {
  it('returns undefined and does not throw when readFile throws; warns once', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const deps: Partial<UsageDeps> = {
      ...memDeps({}),
      readFile: async () => {
        throw new Error('disk died')
      },
      stat: async () => ({
        size: 10,
        mtimeMs: STARTED,
        isFile: () => true,
        isDirectory: () => false
      }),
      homeDir: () => HOME,
      now: () => STARTED,
      platform: 'win32'
    }
    await expect(readTokenUsage(probe(claudeSource), deps)).resolves.toBeUndefined()
    await expect(readTokenUsage(probe(claudeSource), deps)).resolves.toBeUndefined()
    const usageWarns = warn.mock.calls.filter((call) => String(call[0]).startsWith('[usage]'))
    expect(usageWarns).toHaveLength(1)
  })
})
