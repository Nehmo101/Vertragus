/**
 * Pre-approve Cursor Agent MCP servers for a Vertragus worktree.
 *
 * `--approve-mcps` is supposed to do this at launch, but the interactive TUI
 * still stops on a per-server confirmation for many Cursor builds (the flag
 * is hashed per URL and per project dir; extras and the user's own project
 * servers each become another click). A stored approval in
 * `~/.cursor/projects/<slug>/mcp-approvals.json` is the same state-file
 * trick as Claude/Kimi trust: we write it before spawn so the TUI has
 * nothing to ask, and `--approve-mcps` stays on argv as the CLI's own path.
 *
 * Approval key (verified against community write-ups of cursor-agent 2026):
 *   `${name}-${sha256(JSON.stringify({ path: cwd, server })).hex.slice(0, 16)}`
 * where `server` is the object as it sits in `.cursor/mcp.json`.
 *
 * Fail-soft: a home we cannot write, a corrupt approvals file, a missing
 * project mcp.json — the launch proceeds and the user may see the dialog.
 * We only ever ADD keys; foreign entries are preserved.
 */
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

export const CURSOR_HOME_DIR = '.cursor'
export const CURSOR_PROJECTS_DIR = 'projects'
export const CURSOR_APPROVALS_FILE = 'mcp-approvals.json'

export interface CursorMcpApprovalsDeps {
  homeDir?: () => string
  readFile?: (path: string) => string
  writeFile?: (path: string, contents: string) => void
  makeDir?: (path: string) => void
  warn?: (message: string, detail?: unknown) => void
}

export type CursorMcpApprovalsOutcome = 'granted' | 'already-approved' | 'skipped'

export interface CursorMcpApprovalsResult {
  outcome: CursorMcpApprovalsOutcome
  /** Keys written or already present. */
  keys: string[]
  /** `~/.cursor/projects/<slug>/mcp-approvals.json` paths we touched. */
  files: string[]
  reason?: string
}

/** Cursor's project slug: non-alphanumerics become `-`, edges trimmed. */
export function cursorProjectSlug(workspaceDir: string): string {
  return workspaceDir.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '')
}

/**
 * One approval key for a named server as Cursor hashes it: cwd spelling +
 * the exact `mcpServers[name]` object from the project file.
 */
export function cursorMcpApprovalKey(cwd: string, name: string, server: unknown): string {
  const hash = createHash('sha256')
    .update(JSON.stringify({ path: cwd, server }))
    .digest('hex')
    .slice(0, 16)
  return `${name}-${hash}`
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Spellings Cursor might use as `path` in the hash — resolved + as given. */
export function cursorApprovalCwds(workspaceDir: string): string[] {
  const given = workspaceDir.trim()
  if (!given) return []
  const resolved = resolve(given)
  const spellings = new Set([given, resolved, given.replace(/\\/g, '/'), resolved.replace(/\\/g, '/')])
  return [...spellings]
}

function readMcpServers(
  workspaceDir: string,
  readFile: (path: string) => string
): Record<string, unknown> | null {
  const configPath = join(workspaceDir, '.cursor', 'mcp.json')
  try {
    const parsed: unknown = JSON.parse(readFile(configPath))
    if (!isPlainObject(parsed)) return null
    const servers = parsed.mcpServers
    if (!isPlainObject(servers)) return null
    return servers
  } catch {
    return null
  }
}

function readExistingKeys(path: string, readFile: (path: string) => string): string[] {
  try {
    const parsed: unknown = JSON.parse(readFile(path))
    if (!Array.isArray(parsed)) return []
    return parsed.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
  } catch {
    return []
  }
}

function keysFor(workspaceDir: string, servers: Record<string, unknown>): string[] {
  const keys = new Set<string>()
  for (const cwd of cursorApprovalCwds(workspaceDir)) {
    for (const [name, server] of Object.entries(servers)) {
      if (!name.trim()) continue
      keys.add(cursorMcpApprovalKey(cwd, name, server))
    }
  }
  return [...keys]
}

/**
 * Merge approval keys for every server in `<cwd>/.cursor/mcp.json` into
 * `~/.cursor/projects/<slug>/mcp-approvals.json`. Never throws.
 */
export function ensureCursorMcpApprovals(
  workspaceDir: string,
  deps: CursorMcpApprovalsDeps = {}
): CursorMcpApprovalsResult {
  const warn =
    deps.warn ??
    ((message: string, detail?: unknown): void => {
      console.warn(`[cursor-mcp-approvals] ${message}`, detail ?? '')
    })
  const dir = workspaceDir.trim()
  if (!dir) return { outcome: 'skipped', keys: [], files: [], reason: 'no workspace directory' }

  const readFile = deps.readFile ?? ((path: string) => readFileSync(path, 'utf8'))
  const servers = readMcpServers(dir, readFile)
  if (!servers || Object.keys(servers).length === 0) {
    return { outcome: 'skipped', keys: [], files: [], reason: 'no project mcp.json' }
  }

  const wanted = keysFor(dir, servers)
  const home = (deps.homeDir ?? homedir)()
  const makeDir = deps.makeDir ?? ((path: string) => mkdirSync(path, { recursive: true }))
  const writeFile = deps.writeFile ?? ((path: string, contents: string) => writeFileSync(path, contents))

  const slugs = new Set(cursorApprovalCwds(dir).map(cursorProjectSlug).filter(Boolean))
  const files: string[] = []
  const present = new Set<string>()
  let wrote = false

  for (const slug of slugs) {
    const projectDir = join(home, CURSOR_HOME_DIR, CURSOR_PROJECTS_DIR, slug)
    const filePath = join(projectDir, CURSOR_APPROVALS_FILE)
    try {
      makeDir(projectDir)
    } catch (error) {
      warn(`could not create ${projectDir}`, error)
      continue
    }
    const existing = readExistingKeys(filePath, readFile)
    for (const key of existing) present.add(key)
    const merged = [...new Set([...existing, ...wanted])]
    if (merged.length === existing.length && wanted.every((key) => existing.includes(key))) {
      files.push(filePath)
      continue
    }
    try {
      writeFile(filePath, `${JSON.stringify(merged, null, 2)}\n`)
      wrote = true
      files.push(filePath)
      for (const key of wanted) present.add(key)
    } catch (error) {
      warn(`could not write ${filePath}`, error)
    }
  }

  if (files.length === 0) {
    return { outcome: 'skipped', keys: wanted, files: [], reason: 'could not write approvals' }
  }
  if (!wrote) return { outcome: 'already-approved', keys: [...present], files }
  return { outcome: 'granted', keys: wanted, files }
}
