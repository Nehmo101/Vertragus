/**
 * LIVE token-usage reader — the CLIs' own session files on this machine.
 *
 * Unit tests in `src/main/providers/usage.test.ts` prove the parsers against
 * fixtures. This file opens real Claude / Grok / Codex session logs under the
 * current user's home (discovered at runtime, never hardcoded) and checks that
 * `readTokenUsage` agrees with an independent one-pass parse of the same bytes.
 *
 *   VERTRAGUS_LIVE=1 pnpm vitest run tests/live/token-usage.live.test.ts
 *
 * Skipped without `VERTRAGUS_LIVE`. A dialect with no session files here is
 * skipped, not failed — the machine may simply not have that CLI.
 */
import { existsSync, readdirSync, readFileSync, statSync, type Dirent } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readTokenUsage } from '@main/providers/usage'
import type { TokenUsage } from '@shared/schema/events'
import type { UsageSource } from '@shared/schema/provider'

const LIVE = process.env.VERTRAGUS_LIVE === '1'

const CLAUDE_SOURCE: UsageSource = {
  kind: 'claude-jsonl',
  dir: '~/.claude/projects',
  sessionIdArg: '--session-id'
}
const CODEX_SOURCE: UsageSource = { kind: 'codex-rollout', dir: '~/.codex/sessions' }
const GROK_SOURCE: UsageSource = {
  kind: 'grok-session',
  dir: '~/.grok/sessions',
  sessionIdArg: '--session-id'
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : undefined
}

function intOrZero(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : 0
}

function nonnegativeInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined
}

function walkFiles(root: string, pred: (name: string) => boolean): string[] {
  const out: string[] = []
  if (!existsSync(root)) return out
  const stack = [root]
  while (stack.length) {
    const dir = stack.pop()!
    let entries: Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) stack.push(path)
      else if (entry.isFile() && pred(entry.name)) out.push(path)
    }
  }
  return out
}

function newest(paths: string[]): string | undefined {
  if (paths.length === 0) return undefined
  return [...paths].sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0]
}

/** Last `message.usage` per unique `message.id` (fallback `uuid`), then sum. */
function independentClaude(jsonl: string): TokenUsage | undefined {
  const byId = new Map<
    string,
    { input: number; output: number; cacheRead: number; cacheWrite: number }
  >()
  for (const line of jsonl.split(/\r?\n/)) {
    if (!line.trim()) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      continue
    }
    const record = asRecord(parsed)
    const message = record ? asRecord(record.message) : undefined
    const usage = message ? asRecord(message.usage) : undefined
    if (!usage) continue
    const id =
      (typeof message?.id === 'string' && message.id) ||
      (typeof record?.uuid === 'string' && record.uuid) ||
      ''
    if (!id) continue
    byId.set(id, {
      input: intOrZero(usage.input_tokens),
      output: intOrZero(usage.output_tokens),
      cacheRead: intOrZero(usage.cache_read_input_tokens),
      cacheWrite: intOrZero(usage.cache_creation_input_tokens)
    })
  }
  if (byId.size === 0) return undefined
  let input = 0
  let output = 0
  let cacheRead = 0
  let cacheWrite = 0
  for (const row of byId.values()) {
    input += row.input
    output += row.output
    cacheRead += row.cacheRead
    cacheWrite += row.cacheWrite
  }
  return {
    kind: 'consumption',
    input,
    output,
    ...(cacheRead > 0 ? { cacheRead } : {}),
    ...(cacheWrite > 0 ? { cacheWrite } : {}),
    total: input + output + cacheRead + cacheWrite
  }
}

function findClaudeCwd(jsonl: string): string | undefined {
  for (const line of jsonl.split(/\r?\n/)) {
    if (!line.includes('"cwd"')) continue
    try {
      const rec = asRecord(JSON.parse(line))
      if (typeof rec?.cwd === 'string' && rec.cwd.length > 1 && rec.cwd.length < 260) {
        return rec.cwd
      }
    } catch {
      /* continue */
    }
  }
  return undefined
}

function independentGrok(signals?: string, updates?: string): TokenUsage | undefined {
  if (signals) {
    try {
      const parsed = asRecord(JSON.parse(signals))
      const used = parsed ? nonnegativeInt(parsed.contextTokensUsed) : undefined
      if (used !== undefined) {
        const window = parsed ? nonnegativeInt(parsed.contextWindowTokens) : undefined
        return { kind: 'context', used, ...(window !== undefined ? { window } : {}) }
      }
    } catch {
      /* fall through */
    }
  }
  if (!updates) return undefined
  let used: number | undefined
  for (const line of updates.split(/\r?\n/)) {
    if (!line.trim()) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      continue
    }
    const meta = asRecord(asRecord(parsed)?._meta)
    const tokens = meta ? nonnegativeInt(meta.totalTokens) : undefined
    if (tokens !== undefined) used = tokens
  }
  return used !== undefined ? { kind: 'context', used } : undefined
}

function independentCodexLast(jsonl: string): {
  cwd?: string
  startedAt?: number
  usage?: TokenUsage
} {
  let cwd: string | undefined
  let startedAt: number | undefined
  let usage: TokenUsage | undefined
  for (const line of jsonl.split(/\r?\n/)) {
    if (!line.trim()) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      continue
    }
    const record = asRecord(parsed)
    if (!record) continue
    const payload = asRecord(record.payload)
    const isMeta = record.type === 'session_meta' || payload?.type === 'session_meta'
    if (isMeta && cwd === undefined) {
      const body = payload ?? record
      cwd = typeof body.cwd === 'string' ? body.cwd : undefined
      const ts = typeof body.timestamp === 'string' ? body.timestamp : undefined
      startedAt = ts ? Date.parse(ts) : undefined
    }
    const isRecord = record.type === 'token_usage_record' || payload?.type === 'token_usage_record'
    if (!isRecord) continue
    const thread = asRecord(payload?.thread_token_usage) ?? asRecord(record.thread_token_usage)
    if (!thread) continue
    const input = nonnegativeInt(thread.input_tokens)
    const output = nonnegativeInt(thread.output_tokens)
    const total = nonnegativeInt(thread.total_tokens)
    if (input === undefined || output === undefined || total === undefined) continue
    const cacheRead = nonnegativeInt(thread.cached_input_tokens)
    const cacheWrite = nonnegativeInt(thread.cache_write_input_tokens)
    usage = {
      kind: 'consumption',
      input,
      output,
      ...(cacheRead !== undefined ? { cacheRead } : {}),
      ...(cacheWrite !== undefined ? { cacheWrite } : {}),
      total
    }
  }
  return { cwd, startedAt, usage }
}

function grokCwdFromSummary(dir: string): string | undefined {
  const summaryPath = join(dir, 'summary.json')
  if (!existsSync(summaryPath)) return undefined
  try {
    const parsed = asRecord(JSON.parse(readFileSync(summaryPath, 'utf8')))
    const info = parsed ? asRecord(parsed.info) : undefined
    return typeof info?.cwd === 'string' ? info.cwd : undefined
  } catch {
    return undefined
  }
}

describe.skipIf(!LIVE)('readTokenUsage against real CLI session files', () => {
  const home = homedir()

  it('claude-jsonl: kind consumption matches independent unique-message.id sum', async () => {
    const files = walkFiles(join(home, '.claude', 'projects'), (name) =>
      /^[0-9a-f-]{36}\.jsonl$/i.test(name)
    ).filter((path) => dirname(path).includes('vertragus-worktrees'))
    const file = newest(files)
    if (!file) {
      console.warn('[live usage] no Claude vertragus-worktrees session; skipping dialect')
      return
    }
    const jsonl = readFileSync(file, 'utf8')
    const cwd = findClaudeCwd(jsonl)
    expect(cwd, `cwd missing in ${file}`).toBeTruthy()
    const sessionId = basename(file, '.jsonl')
    const independent = independentClaude(jsonl)
    expect(independent?.kind).toBe('consumption')
    const reader = await readTokenUsage({
      source: CLAUDE_SOURCE,
      cwd: cwd!,
      sessionId,
      startedAt: statSync(file).mtimeMs - 60_000
    })
    expect(reader).toEqual(independent)
    expect(reader && reader.kind === 'consumption' ? reader.total : 0).toBeGreaterThan(0)
  })

  it('grok-session: kind context matches signals.json or last updates.jsonl totalTokens', async () => {
    const ownRoot = join(home, '.grok', 'sessions', encodeURIComponent(process.cwd()))
    const ownDirs = existsSync(ownRoot)
      ? readdirSync(ownRoot, { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) => join(ownRoot, entry.name))
      : []
    const ownDir = newest(ownDirs)

    const signalsFile = newest(
      walkFiles(join(home, '.grok', 'sessions'), (name) => name === 'signals.json')
    )
    const finishedDir = signalsFile ? dirname(signalsFile) : undefined

    const targets: Array<{ dir: string; cwd: string }> = []
    if (ownDir) targets.push({ dir: ownDir, cwd: process.cwd() })
    if (finishedDir && finishedDir !== ownDir) {
      const cwd = grokCwdFromSummary(finishedDir)
      if (cwd) targets.push({ dir: finishedDir, cwd })
    }
    if (targets.length === 0) {
      console.warn('[live usage] no Grok session dirs; skipping dialect')
      return
    }

    let scored = 0
    for (const target of targets) {
      const sessionId = basename(target.dir)
      const signalsPath = join(target.dir, 'signals.json')
      const updatesPath = join(target.dir, 'updates.jsonl')
      const signals = existsSync(signalsPath) ? readFileSync(signalsPath, 'utf8') : undefined
      const updates = existsSync(updatesPath) ? readFileSync(updatesPath, 'utf8') : undefined
      const independent = independentGrok(signals, updates)
      const reader = await readTokenUsage({
        source: GROK_SOURCE,
        cwd: target.cwd,
        sessionId,
        startedAt: Date.now() - 86_400_000
      })
      expect(reader, `grok ${target.dir}`).toEqual(independent)
      if (!independent) {
        // Live sessions often have no signals.json yet and a JSON-RPC
        // updates.jsonl with no `_meta.totalTokens`. That is "no recorded
        // number", not a parse mismatch.
        continue
      }
      scored += 1
      expect(reader?.kind).toBe('context')
      expect(reader && reader.kind === 'context' ? reader.used : 0).toBeGreaterThan(0)
    }
    if (scored === 0) {
      console.warn('[live usage] Grok sessions present but none recorded occupancy; skipping dialect')
    }
  })

  it('codex-rollout: last thread_token_usage wins', async () => {
    const file = newest(
      walkFiles(join(home, '.codex', 'sessions'), (name) =>
        name.startsWith('rollout-') && name.endsWith('.jsonl')
      )
    )
    if (!file) {
      console.warn('[live usage] no Codex rollout files; skipping dialect')
      return
    }
    const jsonl = readFileSync(file, 'utf8')
    const independent = independentCodexLast(jsonl)
    expect(independent.cwd, `session_meta.cwd missing in ${file}`).toBeTruthy()
    expect(independent.startedAt, `session_meta.timestamp missing in ${file}`).toBeTruthy()
    expect(independent.usage?.kind).toBe('consumption')
    const reader = await readTokenUsage({
      source: CODEX_SOURCE,
      cwd: independent.cwd!,
      sessionId: 'unused-codex-has-no-pin',
      startedAt: independent.startedAt! - 1_000
    })
    expect(reader).toEqual(independent.usage)
  })

  it('returns undefined without throwing for a missing cwd and a wrong sessionId', async () => {
    const missing = join(home, 'definitely-not-a-real-worktree-9f3c2a')
    const fakeId = '00000000-0000-4000-8000-000000000000'
    const startedAt = Date.now() - 60_000
    await expect(
      readTokenUsage({
        source: CLAUDE_SOURCE,
        cwd: missing,
        sessionId: fakeId,
        startedAt
      })
    ).resolves.toBeUndefined()

    const sample = newest(
      walkFiles(join(home, '.claude', 'projects'), (name) => /^[0-9a-f-]{36}\.jsonl$/i.test(name))
    )
    const cwd = sample ? findClaudeCwd(readFileSync(sample, 'utf8')) ?? process.cwd() : process.cwd()
    await expect(
      readTokenUsage({
        source: CLAUDE_SOURCE,
        cwd,
        sessionId: fakeId,
        startedAt
      })
    ).resolves.toBeUndefined()
    await expect(
      readTokenUsage({
        source: GROK_SOURCE,
        cwd: missing,
        sessionId: fakeId,
        startedAt
      })
    ).resolves.toBeUndefined()
  })
})
