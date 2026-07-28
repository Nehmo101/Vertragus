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
import { appendFile, chmod, mkdir, readdir, readFile, rm } from 'node:fs/promises'
import { promisify } from 'node:util'
import { dirname, join } from 'node:path'
import { canonicalWorkspacePath } from '@main/agents/workspacePath'

const execFileAsync = promisify(execFile)

/** Directory (inside the repo root) that holds all Vertragus-managed worktrees. */
export const WORKTREE_CONTAINER = '.vertragus-worktrees'
/** Pre-rebrand container; still recognized for cleanup/inventory, never written. */
export const LEGACY_WORKTREE_CONTAINER = '.orca-worktrees'

/** Default Git command budget. Discard/status paths use shorter timeouts. */
const GIT_TIMEOUT_MS = 15_000
const GIT_STATUS_TIMEOUT_MS = 3_000
const GIT_DISCARD_TIMEOUT_MS = 8_000
/** Bound concurrent `git status` probes during inventory. */
const INVENTORY_STATUS_CONCURRENCY = 8
/** Windows releases file handles lazily (indexer, AV, watchers) — retry a bit. */
const RM_MAX_RETRIES = 4
const RM_RETRY_DELAY_MS = 120
/** Depth bound for the read-only sweep; agent checkouts never nest that deep. */
const CHMOD_MAX_DEPTH = 24
/** Keep git's stderr readable inside a one-line failure reason. */
const REASON_MAX_LENGTH = 240

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

/** Repo roots whose info/exclude was already ensured during this app run. */
const excludeEnsuredRoots = new Set<string>()

/**
 * Hide the managed worktree containers from `git status` by listing them in the
 * repository's private `<gitdir>/info/exclude` (never the tracked .gitignore).
 * `--git-path info/exclude` resolves the shared info/ location even when the
 * workspace itself is a linked worktree. Idempotent per repo and per file
 * content; failures are logged and never block worktree creation.
 */
async function ensureWorktreeContainerExcluded(root: string): Promise<void> {
  if (excludeEnsuredRoots.has(root)) return
  excludeEnsuredRoots.add(root)
  try {
    const excludePath = await git(root, [
      'rev-parse',
      '--path-format=absolute',
      '--git-path',
      'info/exclude'
    ])
    if (!excludePath) return
    const wanted = [`${WORKTREE_CONTAINER}/`]
    // The legacy container is only worth hiding while it still exists.
    if (existsSync(join(root, LEGACY_WORKTREE_CONTAINER))) {
      wanted.push(`${LEGACY_WORKTREE_CONTAINER}/`)
    }
    let current = ''
    try {
      current = await readFile(excludePath, 'utf8')
    } catch {
      // No info/exclude yet — appendFile below creates it.
    }
    const present = new Set(current.split(/\r?\n/).map((entry) => entry.trim()))
    const missing = wanted.filter(
      (entry) => !present.has(entry) && !present.has(entry.slice(0, -1))
    )
    if (missing.length === 0) return
    await mkdir(dirname(excludePath), { recursive: true })
    const joiner = current.length > 0 && !current.endsWith('\n') ? '\n' : ''
    await appendFile(excludePath, `${joiner}${missing.join('\n')}\n`, 'utf8')
  } catch (error) {
    // Cosmetic only (keeps `git status` clean) — never fail the worktree.
    console.warn('[worktree] info/exclude update skipped', error)
  }
}

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
  await ensureWorktreeContainerExcluded(root)
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
export function isManagedWorktreePath(path: string): boolean {
  return /[\\/]\.(?:vertragus|orca)-worktrees[\\/]/.test(path.trim())
}

/**
 * Only ever delete branches we created under the `vertragus/` namespace (or the
 * legacy `orca/` namespace).
 */
export function isManagedBranch(branch: string): boolean {
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
 * Win32 extended-length form of an absolute path (`\\?\C:\…`, `\\?\UNC\…`).
 *
 * Without it every filesystem call is capped at MAX_PATH (260 chars), which a
 * worktree like `<repo>\.vertragus-worktrees\<session>\<agent>\node_modules\…`
 * blows past routinely — that is why bulk discard reported *every* leftover as
 * failed on Windows. Pure and platform-parameterized so it stays testable.
 */
export function extendedLengthPath(
  path: string,
  platform: NodeJS.Platform = process.platform
): string {
  if (platform !== 'win32') return path
  const backslashed = path.replace(/\//g, '\\')
  if (backslashed.startsWith('\\\\?\\')) return backslashed
  if (backslashed.startsWith('\\\\')) return `\\\\?\\UNC\\${backslashed.slice(2)}`
  if (/^[a-zA-Z]:\\/.test(backslashed)) return `\\\\?\\${backslashed}`
  // Relative or otherwise unusual — leave it to the caller's cwd resolution.
  return path
}

function errorCode(error: unknown): string {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code: unknown }).code)
    : ''
}

/** One-line, user-facing cause — the banner has to explain *why* a discard failed. */
export function describeFsError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  const code = errorCode(error)
  const text = code && !message.startsWith(code) ? `${code}: ${message}` : message
  const collapsed = text.replace(/\s+/g, ' ').trim()
  return collapsed.length > REASON_MAX_LENGTH
    ? `${collapsed.slice(0, REASON_MAX_LENGTH - 1)}…`
    : collapsed
}

/**
 * Windows refuses to delete read-only files (Git packs, npm/pnpm caches keep
 * them around), and `fs.rm` never clears the flag itself. Best-effort sweep
 * before the retry; every individual failure is ignored on purpose.
 */
async function clearReadOnlyFlags(dir: string, depth = 0): Promise<void> {
  if (depth > CHMOD_MAX_DEPTH) return
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    const child = join(dir, entry.name)
    try {
      if (entry.isDirectory()) {
        await chmod(extendedLengthPath(child), 0o700)
        await clearReadOnlyFlags(child, depth + 1)
      } else if (!entry.isSymbolicLink()) {
        await chmod(extendedLengthPath(child), 0o600)
      }
    } catch {
      // Best-effort; the retry below reports whatever is actually left over.
    }
  }
}

/** Delete a directory tree, surviving long paths, transient locks and read-only flags. */
async function removeDirTree(dir: string): Promise<void> {
  const target = extendedLengthPath(dir)
  const options = {
    recursive: true,
    force: true,
    maxRetries: RM_MAX_RETRIES,
    retryDelay: RM_RETRY_DELAY_MS
  } as const
  try {
    await rm(target, options)
    return
  } catch (error) {
    if (!['EPERM', 'EACCES', 'EBUSY', 'ENOTEMPTY'].includes(errorCode(error))) throw error
  }
  await clearReadOnlyFlags(dir)
  await rm(target, options)
}

export interface WorktreeRemoval {
  removed: boolean
  /** Why the removal failed — surfaced to the user, absent on success. */
  reason?: string
}

/**
 * Delete a managed worktree directory from disk when Git cannot remove it.
 * Only paths under `.vertragus-worktrees/` / `.orca-worktrees/` are touched.
 */
async function removeManagedWorktreeDir(worktreePath: string): Promise<WorktreeRemoval> {
  const parts = managedWorktreeParts(worktreePath)
  if (!parts || !isManagedWorktreePath(worktreePath)) {
    return { removed: false, reason: 'Pfad liegt außerhalb der verwalteten Worktree-Ordner.' }
  }
  if (!existsSync(worktreePath)) return { removed: true }
  let reason: string | undefined
  try {
    await removeDirTree(worktreePath)
  } catch (error) {
    reason = describeFsError(error)
  }
  if (existsSync(worktreePath)) {
    return { removed: false, reason: reason ?? 'Ordner ist nach dem Löschen weiterhin vorhanden.' }
  }
  // Drop the empty session container so inventory stops reporting the group.
  const sessionDir = dirname(worktreePath)
  try {
    const leftover = await readdir(sessionDir)
    if (leftover.length === 0) {
      await removeDirTree(sessionDir)
    }
  } catch {
    // Best-effort; the agent checkout itself is already gone.
  }
  return { removed: true }
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
  if (!isManagedBranch(branch)) return
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
  for (const container of [WORKTREE_CONTAINER, LEGACY_WORKTREE_CONTAINER] as const) {
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
  if (!path || !isManagedWorktreePath(path)) return false

  const parts = managedWorktreeParts(path)
  const root = await resolveRollbackRoot(path)
  const targetBranch =
    branch && isManagedBranch(branch)
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

export interface DiscardOrphanFailure {
  path: string
  reason: string
}

export interface DiscardManagedOrphansResult {
  discarded: number
  failed: number
  /** One entry per failed path — without it the UI can only report a count. */
  failures: DiscardOrphanFailure[]
}

/**
 * Discard one leftover: filesystem first (crash leftovers are usually not
 * registered as linked worktrees, so `git worktree remove` only burns timeout
 * budget), then Git as the fallback for a checkout Git still holds.
 */
async function discardOneOrphan(path: string, root: string): Promise<WorktreeRemoval> {
  try {
    if (!existsSync(path)) return { removed: true }
    const direct = await removeManagedWorktreeDir(path)
    if (direct.removed) return direct
    if (!existsSync(root)) return direct

    let gitReason: string | undefined
    try {
      await git(root, ['worktree', 'remove', '--force', path], GIT_DISCARD_TIMEOUT_MS)
    } catch (error) {
      gitReason = describeFsError(error)
    }
    if (!existsSync(path)) return { removed: true }

    const retry = await removeManagedWorktreeDir(path)
    if (retry.removed) return retry
    const reason = retry.reason ?? direct.reason ?? gitReason
    return {
      removed: false,
      reason: gitReason && reason !== gitReason ? `${reason} (git: ${gitReason})` : reason
    }
  } catch (error) {
    return { removed: false, reason: describeFsError(error) }
  }
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
 * - reports a concrete reason for every path it could not remove
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
  const failures: DiscardOrphanFailure[] = []

  for (const path of unique) {
    const parts = managedWorktreeParts(path)
    if (!parts || !isManagedWorktreePath(path)) {
      failures.push({ path, reason: 'Pfad ist kein Vertragus-Worktree.' })
      continue
    }
    if (isOwnedSession(parts.sessionId)) {
      failures.push({ path, reason: 'Gehört zu einer bekannten Session.' })
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
      const outcome = await discardOneOrphan(item.path, root)
      if (outcome.removed) {
        discarded += 1
        branches.add(inferredManagedBranch(item.parts))
      } else {
        failures.push({ path: item.path, reason: outcome.reason ?? 'Unbekannter Fehler.' })
      }
    }

    if (existsSync(root)) {
      for (const branch of branches) {
        await deleteManagedBranch(root, branch)
      }
      await pruneWorktrees(root)
    }
  }

  return { discarded, failed: failures.length, failures }
}
