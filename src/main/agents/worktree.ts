/**
 * Git worktree isolation: each agent gets its own worktree + branch so
 * parallel (especially Yolo) agents never collide in the same checkout.
 *
 * Worktrees live under <repoRoot>/.vertragus-worktrees/<sessionId>/<agentId> on
 * branch vertragus/<sessionId>/<agentId>. Legacy `.orca-worktrees` checkouts and
 * `orca/` branches created before the rebrand stay recognizable so they can
 * still be cleaned up. Stopping a single agent keeps its worktree
 * so its work can still be inspected; killing (removing) a whole workspace run
 * rolls the agents back via `rollbackWorktree`, discarding the isolated
 * checkout and its branch.
 */
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readdir, rm } from 'node:fs/promises'
import { promisify } from 'node:util'
import { dirname, join } from 'node:path'
import { canonicalWorkspacePath } from '@main/agents/workspacePath'

const execFileAsync = promisify(execFile)

/** Default Git command budget. Discard/status paths use shorter timeouts. */
const GIT_TIMEOUT_MS = 15_000
const GIT_STATUS_TIMEOUT_MS = 3_000
const GIT_DISCARD_TIMEOUT_MS = 8_000
/** Bound concurrent `git status` probes during inventory. */
const INVENTORY_STATUS_CONCURRENCY = 8

async function git(cwd: string, args: string[], timeoutMs = GIT_TIMEOUT_MS): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', cwd, ...args], {
    windowsHide: true,
    timeout: timeoutMs
  })
  return stdout.trim()
}

async function mapPool<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T) => Promise<R>
): Promise<R[]> {
  if (items.length === 0) return []
  const results = new Array<R>(items.length)
  let next = 0
  const run = async (): Promise<void> => {
    while (next < items.length) {
      const index = next
      next += 1
      results[index] = await worker(items[index]!)
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => run())
  )
  return results
}

export async function repoRoot(dir: string): Promise<string | null> {
  try {
    return await git(dir, ['rev-parse', '--show-toplevel'])
  } catch {
    return null
  }
}

export async function currentBranch(dir: string): Promise<string | null> {
  try {
    return await git(dir, ['rev-parse', '--abbrev-ref', 'HEAD'])
  } catch {
    return null
  }
}

export interface WorktreeResult {
  path: string
  branch: string
}

/** Directory name a session id gets under `.vertragus-worktrees/`; null if unsafe. */
export function worktreeSessionDirName(sessionId: string): string | null {
  try {
    return safeIdentityPart(sessionId, 'Session-ID')
  } catch {
    return null
  }
}

function safeIdentityPart(value: string, label: string): string {
  const safe = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  if (!safe) throw new Error(`${label} ergibt keine sichere Git-Identität`)
  return safe
}

/**
 * Build a unique, inspectable identity without consulting or mutating Git.
 * The session id keeps process-local agent ids from colliding after an app
 * restart. Existing branches/worktrees are deliberately never reused.
 */
export function worktreeIdentity(
  root: string,
  agentId: string,
  sessionId: string
): WorktreeResult {
  const safeSession = safeIdentityPart(sessionId, 'Session-ID')
  const safeAgent = safeIdentityPart(agentId, 'Agent-ID')
  return {
    path: join(root, '.vertragus-worktrees', safeSession, safeAgent),
    branch: `vertragus/${safeSession}/${safeAgent}`
  }
}

async function branchExists(root: string, branch: string): Promise<boolean> {
  try {
    await git(root, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`])
    return true
  } catch {
    return false
  }
}

/** Max slot probes per agent identity before giving up (defensive bound). */
const WORKTREE_SLOT_ATTEMPTS = 20

/**
 * Create a fresh isolated worktree for the given agent and app session.
 * A non-Git directory returns null. Git failures are surfaced to the caller;
 * falling back to a shared checkout would silently disable isolation.
 *
 * Session ids are persisted and survive app restarts, while agent-id sequences
 * start over — a resumed session would collide with its previous run's
 * worktrees. Existing checkouts are deliberately never reused (an unrelated
 * fresh task must not see foreign uncommitted changes; continuing old work
 * goes through the explicit recovery-worktree path), so occupied identities
 * are skipped with an `-r<n>` suffix instead.
 *
 * When `baseRef` is given, the worktree branches from that commit instead of
 * the repository's current HEAD. This lets a dependent task start from the
 * merge point of its `dependsOn` tasks so their delivered files are present —
 * without it a dependent worktree branches from HEAD and the central typecheck
 * fails on unresolvable imports (retros mrqv1blp, mrn5qqe4). An unresolvable
 * `baseRef` falls back to HEAD rather than failing the task outright.
 */
export async function createWorktree(
  dir: string,
  agentId: string,
  sessionId: string = randomUUID(),
  baseRef?: string
): Promise<WorktreeResult | null> {
  const discoveredRoot = await repoRoot(dir)
  if (!discoveredRoot) return null
  const root = await canonicalWorkspacePath(discoveredRoot)
  let identity = worktreeIdentity(root, agentId, sessionId)
  for (let attempt = 2; attempt <= WORKTREE_SLOT_ATTEMPTS; attempt += 1) {
    if (!existsSync(identity.path) && !(await branchExists(root, identity.branch))) break
    identity = worktreeIdentity(root, `${agentId}-r${attempt}`, sessionId)
  }
  await mkdir(dirname(identity.path), { recursive: true })
  let resolvedBase: string | undefined
  if (baseRef?.trim()) {
    try {
      resolvedBase = await git(root, ['rev-parse', '--verify', baseRef.trim() + '^{commit}'])
    } catch {
      // A base that no longer resolves (pruned worktree branch) must not sink
      // the task; branch from HEAD instead.
      resolvedBase = undefined
    }
  }
  try {
    const addArgs = ['worktree', 'add', '-b', identity.branch, identity.path]
    if (resolvedBase) addArgs.push(resolvedBase)
    await git(root, addArgs)
    return { ...identity, path: await canonicalWorkspacePath(identity.path) }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    throw new Error(`Worktree ${identity.branch} konnte nicht erstellt werden: ${detail}`, {
      cause: err
    })
  }
}

/**
 * Only ever touch paths we created under `.vertragus-worktrees/` (or the legacy
 * `.orca-worktrees/`, so pre-rebrand checkouts stay cleanable).
 */
export function isOrcaWorktreePath(path: string): boolean {
  return /[\\/]\.(?:vertragus|orca)-worktrees[\\/]/.test(path.trim())
}

/**
 * Only ever delete branches we created under the `vertragus/` namespace (or the
 * legacy `orca/` namespace).
 */
export function isOrcaBranch(branch: string): boolean {
  return /^(?:vertragus|orca)\//.test(branch.trim())
}

export interface ManagedWorktreeParts {
  /** Repository root that owns `.vertragus-worktrees` / `.orca-worktrees`. */
  root: string
  sessionId: string
  agentId: string
  /** True for pre-rebrand `.orca-worktrees` checkouts. */
  legacy: boolean
}

/**
 * Parse a managed agent worktree path into repo root + identity parts.
 * Works from the path alone — no Git calls — so broken leftovers still match.
 */
export function managedWorktreeParts(worktreePath: string): ManagedWorktreeParts | null {
  const normalized = worktreePath.trim().replace(/\\/g, '/').replace(/\/+$/, '')
  const match = normalized.match(/^(.*)\/\.(vertragus|orca)-worktrees\/([^/]+)\/([^/]+)$/)
  if (!match?.[1] || !match[2] || !match[3] || !match[4]) return null
  return {
    root: match[1],
    legacy: match[2] === 'orca',
    sessionId: match[3],
    agentId: match[4]
  }
}

/** Branch name that `createWorktree` would have used for this checkout path. */
export function inferredManagedBranch(parts: ManagedWorktreeParts): string {
  return `${parts.legacy ? 'orca' : 'vertragus'}/${parts.sessionId}/${parts.agentId}`
}

/**
 * Resolve the main working tree that owns a linked worktree, so
 * `git worktree remove` runs from the repository root instead of from inside
 * the worktree being removed (Git refuses to remove the current tree).
 */
async function mainWorktreeRoot(worktreePath: string): Promise<string | null> {
  try {
    const commonDir = await git(worktreePath, [
      'rev-parse',
      '--path-format=absolute',
      '--git-common-dir'
    ])
    // The shared git dir of a normal checkout is <root>/.git.
    return commonDir ? dirname(commonDir) : null
  } catch {
    return null
  }
}

/**
 * Prefer a path-derived repo root so discard still works when the worktree's
 * gitdir is corrupt or the checkout is no longer registered with Git.
 */
async function resolveRollbackRoot(worktreePath: string): Promise<string | null> {
  const parts = managedWorktreeParts(worktreePath)
  if (parts?.root && existsSync(parts.root)) {
    return canonicalWorkspacePath(parts.root)
  }
  const fromGit = await mainWorktreeRoot(worktreePath)
  return fromGit ? canonicalWorkspacePath(fromGit) : null
}

/**
 * Delete a managed worktree directory from disk when Git cannot remove it.
 * Only paths under `.vertragus-worktrees/` / `.orca-worktrees/` are touched.
 */
async function removeManagedWorktreeDir(worktreePath: string): Promise<boolean> {
  const parts = managedWorktreeParts(worktreePath)
  if (!parts || !isOrcaWorktreePath(worktreePath)) return false
  if (!existsSync(worktreePath)) return true
  try {
    await rm(worktreePath, { recursive: true, force: true })
  } catch {
    return existsSync(worktreePath) === false
  }
  // Drop the empty session container so inventory stops reporting the group.
  const sessionDir = dirname(worktreePath)
  try {
    const leftover = await readdir(sessionDir)
    if (leftover.length === 0) {
      await rm(sessionDir, { recursive: true, force: true })
    }
  } catch {
    // Best-effort; the agent checkout itself is already gone.
  }
  return existsSync(worktreePath) === false
}

/** Best-effort `git worktree prune` for a repository root. */
export async function pruneWorktrees(root: string): Promise<void> {
  const trimmed = root.trim()
  if (!trimmed || !existsSync(trimmed)) return
  try {
    await git(trimmed, ['worktree', 'prune'], GIT_DISCARD_TIMEOUT_MS)
  } catch {
    // Prune is metadata cleanup only.
  }
}

async function deleteManagedBranch(root: string, branch: string): Promise<void> {
  if (!isOrcaBranch(branch)) return
  try {
    await git(root, ['branch', '-D', branch], GIT_DISCARD_TIMEOUT_MS)
  } catch {
    // Branch may already be gone or never created.
  }
}

/**
 * Roll back (discard) a Vertragus-managed isolated worktree and its branch.
 *
 * Rolling back a killed workspace deliberately throws away the agent's
 * uncommitted, unmerged work, so removal is forced. As a hard safety net only
 * managed worktrees and branches are ever touched — the main checkout and user
 * branches are never affected. The ownership guards accept both the current
 * `.vertragus-worktrees`/`vertragus/` and the legacy `.orca-worktrees`/`orca/`
 * namespaces, so pre-rebrand runs can still be rolled back. Every Git failure is
 * swallowed (best-effort cleanup); returns true when the worktree or its branch
 * was actually removed.
 */
export interface WorktreeInventoryEntry {
  path: string
  sessionId: string
  agentId: string
  /** True for pre-rebrand `.orca-worktrees` checkouts. */
  legacy: boolean
  /** True when the session id is still known to the session index. */
  owned: boolean
  /** Uncommitted changes (git status entries); undefined when git failed. */
  changedFiles?: number
}

export interface InventoryWorktreesOptions {
  /** When false, skip `git status` (much faster after bulk discard). Default true. */
  includeChangeCounts?: boolean
}

/**
 * List every Vertragus-managed worktree under a repository and classify it
 * against the currently known session ids. Never mutates anything — orphaned
 * checkouts (from removed or pre-persistence sessions) are only reported, so
 * uncommitted work is preserved until the user explicitly discards it.
 */
export async function inventoryWorktrees(
  dir: string,
  knownSessionIds: ReadonlySet<string>,
  options: InventoryWorktreesOptions = {}
): Promise<WorktreeInventoryEntry[]> {
  const includeChangeCounts = options.includeChangeCounts !== false
  const discoveredRoot = await repoRoot(dir)
  if (!discoveredRoot) return []
  const root = await canonicalWorkspacePath(discoveredRoot)
  // Directory names carry the sanitized identity; compare like for like.
  const known = new Set(
    [...knownSessionIds].flatMap((id) => {
      try {
        return [safeIdentityPart(id, 'Session-ID')]
      } catch {
        return []
      }
    })
  )
  const discovered: Array<Omit<WorktreeInventoryEntry, 'changedFiles' | 'owned'> & { owned: boolean }> =
    []
  for (const container of ['.vertragus-worktrees', '.orca-worktrees'] as const) {
    const containerPath = join(root, container)
    const sessions = await readdir(containerPath, { withFileTypes: true }).catch(() => [])
    for (const session of sessions) {
      if (!session.isDirectory()) continue
      const agents = await readdir(join(containerPath, session.name), {
        withFileTypes: true
      }).catch(() => [])
      for (const agent of agents) {
        if (!agent.isDirectory()) continue
        discovered.push({
          path: join(containerPath, session.name, agent.name),
          sessionId: session.name,
          agentId: agent.name,
          legacy: container === '.orca-worktrees',
          owned: known.has(session.name)
        })
      }
    }
  }

  if (!includeChangeCounts || discovered.length === 0) {
    return discovered.map((entry) => ({ ...entry }))
  }

  const changed = await mapPool(discovered, INVENTORY_STATUS_CONCURRENCY, async (entry) => {
    try {
      const status = await git(entry.path, ['status', '--porcelain'], GIT_STATUS_TIMEOUT_MS)
      return status ? status.split('\n').filter(Boolean).length : 0
    } catch {
      return undefined
    }
  })

  return discovered.map((entry, index) => ({
    ...entry,
    changedFiles: changed[index]
  }))
}

export interface RollbackWorktreeOptions {
  /**
   * Run `git worktree prune` after this single rollback. Bulk orphan discard
   * sets this to false and prunes once per repository instead.
   */
  prune?: boolean
}

/**
 * Roll back (discard) a Vertragus-managed isolated worktree and its branch.
 *
 * Success means the checkout directory is gone — deleting only the branch is
 * not enough, because inventory scans the filesystem. Broken / unregistered
 * leftovers fall back to a direct directory delete under the managed namespace.
 */
export async function rollbackWorktree(
  worktreePath: string,
  branch?: string,
  options: RollbackWorktreeOptions = {}
): Promise<boolean> {
  const path = worktreePath.trim()
  if (!path || !isOrcaWorktreePath(path)) return false

  const parts = managedWorktreeParts(path)
  const root = await resolveRollbackRoot(path)
  const targetBranch =
    branch && isOrcaBranch(branch)
      ? branch
      : parts
        ? inferredManagedBranch(parts)
        : undefined
  const shouldPrune = options.prune !== false

  if (root && existsSync(path)) {
    try {
      await git(root, ['worktree', 'remove', '--force', path], GIT_DISCARD_TIMEOUT_MS)
    } catch {
      // Locked, corrupt, or never registered — fall through to FS delete.
    }
  }

  if (existsSync(path)) {
    await removeManagedWorktreeDir(path)
  }

  if (root && targetBranch) {
    await deleteManagedBranch(root, targetBranch)
  }

  if (root && shouldPrune) {
    await pruneWorktrees(root)
  }

  return !existsSync(path)
}

export interface DiscardManagedOrphansResult {
  discarded: number
  failed: number
}

/**
 * Discard many managed orphan checkouts safely.
 *
 * Parallel Git mutations on one repository race on locks and were the main
 * reason bulk "Verwerfen" hung or left ghosts. This path:
 * - refuses owned session dirs
 * - deletes checkouts one-by-one per repository (filesystem-first)
 * - deletes inferred branches afterward
 * - runs `git worktree prune` once per repository
 */
export async function discardManagedOrphans(
  paths: readonly string[],
  isOwnedSession: (sessionId: string) => boolean
): Promise<DiscardManagedOrphansResult> {
  const unique = [
    ...new Set(paths.map((path) => (typeof path === 'string' ? path.trim() : '')).filter(Boolean))
  ]

  type Item = { path: string; parts: ManagedWorktreeParts }
  const byRoot = new Map<string, Item[]>()
  let failed = 0

  for (const path of unique) {
    const parts = managedWorktreeParts(path)
    if (!parts || !isOrcaWorktreePath(path)) {
      failed += 1
      continue
    }
    if (isOwnedSession(parts.sessionId)) {
      failed += 1
      continue
    }
    const group = byRoot.get(parts.root) ?? []
    group.push({ path, parts })
    byRoot.set(parts.root, group)
  }

  let discarded = 0
  for (const [rootHint, items] of byRoot) {
    const root = existsSync(rootHint) ? await canonicalWorkspacePath(rootHint) : rootHint
    const branches = new Set<string>()

    for (const item of items) {
      try {
        // Filesystem-first: crash leftovers are often not registered as linked
        // worktrees, so `git worktree remove` only burns timeout budget.
        let gone = !existsSync(item.path)
        if (!gone) {
          gone = await removeManagedWorktreeDir(item.path)
        }
        if (!gone && existsSync(item.path) && existsSync(root)) {
          try {
            await git(root, ['worktree', 'remove', '--force', item.path], GIT_DISCARD_TIMEOUT_MS)
          } catch {
            // still try one more FS pass below
          }
          if (existsSync(item.path)) {
            gone = await removeManagedWorktreeDir(item.path)
          } else {
            gone = true
          }
        }
        if (gone) {
          discarded += 1
          branches.add(inferredManagedBranch(item.parts))
        } else {
          failed += 1
        }
      } catch {
        failed += 1
      }
    }

    if (existsSync(root)) {
      for (const branch of branches) {
        await deleteManagedBranch(root, branch)
      }
      await pruneWorktrees(root)
    }
  }

  return { discarded, failed }
}
