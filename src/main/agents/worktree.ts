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

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', cwd, ...args], {
    windowsHide: true,
    timeout: 15000
  })
  return stdout.trim()
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
    return false
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
  return true
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

/**
 * List every Vertragus-managed worktree under a repository and classify it
 * against the currently known session ids. Never mutates anything — orphaned
 * checkouts (from removed or pre-persistence sessions) are only reported, so
 * uncommitted work is preserved until the user explicitly discards it.
 */
export async function inventoryWorktrees(
  dir: string,
  knownSessionIds: ReadonlySet<string>
): Promise<WorktreeInventoryEntry[]> {
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
  const entries: WorktreeInventoryEntry[] = []
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
        const path = join(containerPath, session.name, agent.name)
        let changedFiles: number | undefined
        try {
          const status = await git(path, ['status', '--porcelain'])
          changedFiles = status ? status.split('\n').length : 0
        } catch {
          changedFiles = undefined
        }
        entries.push({
          path,
          sessionId: session.name,
          agentId: agent.name,
          legacy: container === '.orca-worktrees',
          owned: known.has(session.name),
          changedFiles
        })
      }
    }
  }
  return entries
}

export async function rollbackWorktree(
  worktreePath: string,
  branch?: string
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

  let removed = false
  if (root) {
    try {
      await git(root, ['worktree', 'remove', '--force', path])
      removed = true
    } catch {
      // The checkout may already be gone, locked, or never registered.
    }

    if (targetBranch && isOrcaBranch(targetBranch)) {
      try {
        await git(root, ['branch', '-D', targetBranch])
        removed = true
      } catch {
        // The branch may never have been created (failed `worktree add`).
      }
    }

    try {
      await git(root, ['worktree', 'prune'])
    } catch {
      // Prune is best-effort metadata cleanup.
    }
  }

  // Broken leftovers (corrupt gitdir, unregistered dirs) still show up in the
  // filesystem inventory. Delete them directly so "Verwerfen" actually clears
  // the restore banner instead of silently failing.
  if (existsSync(path)) {
    if (await removeManagedWorktreeDir(path)) removed = true
  } else if (!removed && parts) {
    // Already absent on disk after a successful git remove / prior cleanup.
    removed = true
  }

  return removed
}
