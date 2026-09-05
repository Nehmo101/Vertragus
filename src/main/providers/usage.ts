/**
 * Host-side readers for CLI-recorded token usage. Never estimates: a missing
 * file, an oversized file, or a parse failure is `undefined`.
 */
import { readdir as fsReaddir, readFile as fsReadFile, stat as fsStat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, posix, win32 } from 'node:path'
import { expandHome } from '@main/providers/discovery'
import type { TokenUsage } from '@shared/schema/events'
import type { UsageSource } from '@shared/schema/provider'

export interface UsageProbe {
  source: UsageSource
  /** The agent's worktree — what the CLI recorded as cwd. */
  cwd: string
  /** The agent id, which doubles as the pinned CLI session id. */
  sessionId: string
  /** Epoch ms the agent process started; files older than this are not its. */
  startedAt: number
}

export interface UsageDeps {
  readFile(path: string): Promise<string>
  readdir(path: string): Promise<string[]>
  stat(path: string): Promise<{
    size: number
    mtimeMs: number
    isFile(): boolean
    isDirectory(): boolean
  }>
  homeDir(): string
  now(): number
  platform: NodeJS.Platform
}

export const USAGE_FILE_MAX_BYTES = 64 * 1024 * 1024

const CODEX_START_SLACK_MS = 60_000
const DAY_MS = 86_400_000

let usageWarned = false

/** Test hook: the once-per-process warn flag otherwise leaks across cases. */
export function resetUsageWarning(): void {
  usageWarned = false
}

function warnUsage(error: unknown): void {
  if (usageWarned) return
  usageWarned = true
  console.warn('[usage] failed to read token usage:', error)
}

function isNotFound(error: unknown): boolean {
  return Boolean(
    error && typeof error === 'object' && 'code' in error && (error as { code: string }).code === 'ENOENT'
  )
}

function defaultDeps(partial: Partial<UsageDeps> = {}): UsageDeps {
  return {
    readFile: async (path) => fsReadFile(path, 'utf8'),
    readdir: async (path) => fsReaddir(path),
    stat: async (path) => {
      const info = await fsStat(path)
      return {
        size: info.size,
        mtimeMs: info.mtimeMs,
        isFile: () => info.isFile(),
        isDirectory: () => info.isDirectory()
      }
    },
    homeDir: () => homedir(),
    now: () => Date.now(),
    platform: process.platform,
    ...partial
  }
}

function nonnegativeInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined
}

function intOrZero(value: unknown): number {
  return nonnegativeInt(value) ?? 0
}

function stripTrailingSeps(value: string): string {
  if (value.length <= 1) return value
  const stripped = value.replace(/[\\/]+$/, '')
  return stripped.length > 0 ? stripped : value
}

export function sameCwd(a: string, b: string, platform: NodeJS.Platform): boolean {
  const resolve = platform === 'win32' ? win32.resolve : posix.resolve
  const left = stripTrailingSeps(resolve(a))
  const right = stripTrailingSeps(resolve(b))
  if (platform === 'win32') return left.toLowerCase() === right.toLowerCase()
  return left === right
}

/** Every character outside `[A-Za-z0-9]` becomes `-`, not collapsed. */
export function claudeProjectSlug(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, '-')
}

export function grokEncodedCwd(cwd: string): string {
  return encodeURIComponent(cwd)
}

export function sumClaudeUsage(jsonl: string): TokenUsage | undefined {
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
    if (!parsed || typeof parsed !== 'object') continue
    const record = parsed as Record<string, unknown>
    const message = record.message
    if (!message || typeof message !== 'object') continue
    const msg = message as Record<string, unknown>
    const usage = msg.usage
    if (!usage || typeof usage !== 'object') continue
    const fields = usage as Record<string, unknown>
    const id =
      (typeof msg.id === 'string' && msg.id) || (typeof record.uuid === 'string' && record.uuid) || ''
    if (!id) continue
    byId.set(id, {
      input: intOrZero(fields.input_tokens),
      output: intOrZero(fields.output_tokens),
      cacheRead: intOrZero(fields.cache_read_input_tokens),
      cacheWrite: intOrZero(fields.cache_creation_input_tokens)
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

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : undefined
}

function parseTimestamp(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim()) {
    const ms = Date.parse(value)
    return Number.isFinite(ms) ? ms : undefined
  }
  return undefined
}

export function codexRolloutHeader(jsonl: string): {
  cwd?: string
  sessionId?: string
  startedAt?: number
} {
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
    if (!isMeta) continue
    const body = payload ?? record
    const cwd = typeof body.cwd === 'string' ? body.cwd : undefined
    const sessionId =
      typeof body.session_id === 'string'
        ? body.session_id
        : typeof body.id === 'string'
          ? body.id
          : undefined
    const startedAt = parseTimestamp(body.timestamp)
    return { cwd, sessionId, startedAt }
  }
  return {}
}

function consumptionFromThread(thread: Record<string, unknown>): TokenUsage | undefined {
  const input = nonnegativeInt(thread.input_tokens)
  const output = nonnegativeInt(thread.output_tokens)
  const total = nonnegativeInt(thread.total_tokens)
  if (input === undefined || output === undefined || total === undefined) return undefined
  const cacheRead = nonnegativeInt(thread.cached_input_tokens)
  const cacheWrite = nonnegativeInt(thread.cache_write_input_tokens)
  return {
    kind: 'consumption',
    input,
    output,
    ...(cacheRead !== undefined ? { cacheRead } : {}),
    ...(cacheWrite !== undefined ? { cacheWrite } : {}),
    total
  }
}

export function codexUsageFromRollout(jsonl: string): TokenUsage | undefined {
  let last: TokenUsage | undefined
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
    const isRecord = record.type === 'token_usage_record' || payload?.type === 'token_usage_record'
    if (!isRecord) continue
    const thread = asRecord(payload?.thread_token_usage) ?? asRecord(record.thread_token_usage)
    if (!thread) continue
    const usage = consumptionFromThread(thread)
    if (usage) last = usage
  }
  return last
}

export function grokContextUsage(files: { signals?: string; updates?: string }): TokenUsage | undefined {
  if (files.signals) {
    try {
      const parsed = asRecord(JSON.parse(files.signals))
      const used = parsed ? nonnegativeInt(parsed.contextTokensUsed) : undefined
      if (used !== undefined) {
        const window = parsed ? nonnegativeInt(parsed.contextWindowTokens) : undefined
        return { kind: 'context', used, ...(window !== undefined ? { window } : {}) }
      }
    } catch {
      /* fall through to updates */
    }
  }
  if (!files.updates) return undefined
  let used: number | undefined
  for (const line of files.updates.split(/\r?\n/)) {
    if (!line.trim()) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      continue
    }
    const record = asRecord(parsed)
    const meta = record ? asRecord(record._meta) : undefined
    const tokens = meta ? nonnegativeInt(meta.totalTokens) : undefined
    if (tokens !== undefined) used = tokens
  }
  return used !== undefined ? { kind: 'context', used } : undefined
}

function dateKey(ms: number): string {
  const date = new Date(ms)
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}/${month}/${day}`
}

function dateKeysInclusive(fromMs: number, toMs: number): string[] {
  const start = new Date(Math.min(fromMs, toMs))
  start.setHours(0, 0, 0, 0)
  const end = new Date(Math.max(fromMs, toMs))
  end.setHours(0, 0, 0, 0)
  const keys: string[] = []
  const cursor = new Date(start)
  while (cursor.getTime() <= end.getTime()) {
    keys.push(dateKey(cursor.getTime()))
    cursor.setDate(cursor.getDate() + 1)
  }
  return keys
}

async function readCappedFile(
  path: string,
  deps: UsageDeps
): Promise<string | undefined> {
  try {
    const info = await deps.stat(path)
    if (!info.isFile() || info.size > USAGE_FILE_MAX_BYTES) return undefined
    return await deps.readFile(path)
  } catch (error) {
    if (isNotFound(error)) return undefined
    throw error
  }
}

async function readClaude(probe: UsageProbe, deps: UsageDeps): Promise<TokenUsage | undefined> {
  const filePath = join(
    expandHome(probe.source.dir, deps.homeDir()),
    claudeProjectSlug(probe.cwd),
    `${probe.sessionId}.jsonl`
  )
  const jsonl = await readCappedFile(filePath, deps)
  return jsonl === undefined ? undefined : sumClaudeUsage(jsonl)
}

async function readCodex(probe: UsageProbe, deps: UsageDeps): Promise<TokenUsage | undefined> {
  const root = expandHome(probe.source.dir, deps.homeDir())
  const keys = dateKeysInclusive(probe.startedAt - DAY_MS, deps.now())
  let best:
    | { usage: TokenUsage; rank: number }
    | undefined
  for (const key of keys) {
    const dir = join(root, ...key.split('/'))
    let names: string[]
    try {
      names = await deps.readdir(dir)
    } catch (error) {
      if (isNotFound(error)) continue
      throw error
    }
    for (const name of names) {
      if (!name.startsWith('rollout-') || !name.endsWith('.jsonl')) continue
      const filePath = join(dir, name)
      const jsonl = await readCappedFile(filePath, deps)
      if (jsonl === undefined) continue
      const header = codexRolloutHeader(jsonl)
      if (!header.cwd || !sameCwd(header.cwd, probe.cwd, deps.platform)) continue
      const stamp = header.startedAt ?? 0
      if (stamp < probe.startedAt - CODEX_START_SLACK_MS) continue
      const usage = codexUsageFromRollout(jsonl)
      if (!usage) continue
      const rank = header.startedAt ?? 0
      if (!best || rank >= best.rank) best = { usage, rank }
    }
  }
  return best?.usage
}

async function readGrok(probe: UsageProbe, deps: UsageDeps): Promise<TokenUsage | undefined> {
  const dir = join(
    expandHome(probe.source.dir, deps.homeDir()),
    grokEncodedCwd(probe.cwd),
    probe.sessionId
  )
  const summary = await readCappedFile(join(dir, 'summary.json'), deps)
  if (summary !== undefined) {
    let cwd: string | undefined
    try {
      const parsed = asRecord(JSON.parse(summary))
      const info = parsed ? asRecord(parsed.info) : undefined
      cwd = typeof info?.cwd === 'string' ? info.cwd : undefined
    } catch {
      return undefined
    }
    if (!cwd || !sameCwd(cwd, probe.cwd, deps.platform)) return undefined
  }
  const signals = await readCappedFile(join(dir, 'signals.json'), deps)
  const updates = await readCappedFile(join(dir, 'updates.jsonl'), deps)
  return grokContextUsage({
    ...(signals !== undefined ? { signals } : {}),
    ...(updates !== undefined ? { updates } : {})
  })
}

/** Never throws. Undefined = no recorded number (missing file, cap, parse failure). */
export async function readTokenUsage(
  probe: UsageProbe,
  deps?: Partial<UsageDeps>
): Promise<TokenUsage | undefined> {
  const resolved = defaultDeps(deps)
  try {
    switch (probe.source.kind) {
      case 'claude-jsonl':
        return await readClaude(probe, resolved)
      case 'codex-rollout':
        return await readCodex(probe, resolved)
      case 'grok-session':
        return await readGrok(probe, resolved)
    }
  } catch (error) {
    warnUsage(error)
    return undefined
  }
}
