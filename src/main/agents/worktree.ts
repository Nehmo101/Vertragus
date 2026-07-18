/**
 * Git worktree isolation: each agent gets its own worktree + branch so
 * parallel (especially Yolo) agents never collide in the same checkout.
 *
 * Worktrees live under <repoRoot>/.vertragus-worktrees/<sessionId>/<agentId> on
 * branch vertragus/<sessionId>/<agentId>. Stopping a single agent keeps its
 * worktree so its work can still be inspected; killing (removing) a whole
 * workspace run rolls the agents back via `rollbackWorktree`, discarding the
 * isolated checkout and its branch.
 *
 * Legacy note: worktrees created by earlier builds live under `.orca-worktrees`
 * on `orca/…` branches. The ownership guards below deliberately accept both the
 * current `vertragus` namespace and the legacy `orca` one, so pre-existing
 * checkouts keep being recognised and cleaned up without any migration or data
 * loss. New worktrees are only ever created under the current namespace.
 */
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { promisify } from 'node:util'
import { dirname, join } from 'node:path'
import { canonicalWorkspacePath } from '@main/agents/workspacePath'

const execFileAsync = promisify(execFile)

/** Directory that holds the isolated worktrees created by current builds. */
export const WORKTREE_DIR_NAME = '.vertragus-worktrees'
/** Directory used by earlier builds; still recognised for cleanup only. */
export const LEGACY_WORKTREE_DIR_NAME = '.orca-worktrees'
/** Branch namespace for worktrees created by current builds. */
export const WORKTREE_BRANCH_PREFIX = 'vertragus/'
/** Branch namespace used by earlier builds; still recognised for cleanup only. */
export const LEGACY_WORKTREE_BRANCH_PREFIX = 'orca/'

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
    path: join(root, WORKTREE_DIR_NAME, safeSession, safeAgent),
    branch: `${WORKTREE_BRANCH_PREFIX}${safeSession}/${safeAgent}`
  }
}

/**
 * Create a fresh isolated worktree for the given agent and app session.
 * A non-Git directory returns null. Git failures are surfaced to the caller;
 * falling back to a shared checkout would silently disable isolation.
 */
export async function createWorktree(
  dir: string,
  agentId: string,
  sessionId: string = randomUUID()
): Promise<WorktreeResult | null> {
  const discoveredRoot = await repoRoot(dir)
  if (!discoveredRoot) return null
  const root = await canonicalWorkspacePath(discoveredRoot)
  const identity = worktreeIdentity(root, agentId, sessionId)
  await mkdir(dirname(identity.path), { recursive: true })
  try {
    await git(root, ['worktree', 'add', '-b', identity.branch, identity.path])
    return { ...identity, path: await canonicalWorkspacePath(identity.path) }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    throw new Error(`Worktree ${identity.branch} konnte nicht erstellt werden: ${detail}`, {
      cause: err
    })
  }
}

/**
 * Only ever touch paths Vertragus created under its managed worktree dir.
 * Legacy `.orca-worktrees` checkouts are still matched so pre-existing runs can
 * be cleaned up without a migration step.
 */
export function isManagedWorktreePath(path: string): boolean {
  return /[\\/]\.(?:vertragus|orca)-worktrees[\\/]/.test(path.trim())
}

/**
 * Only ever delete branches Vertragus created under its managed namespace.
 * Legacy `orca/…` branches are still matched for cleanup of pre-existing runs.
 */
export function isManagedBranch(branch: string): boolean {
  return /^(?:vertragus|orca)\//.test(branch.trim())
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
 * Roll back (discard) a Vertragus-managed isolated worktree and its branch.
 *
 * Rolling back a killed workspace deliberately throws away the agent's
 * uncommitted, unmerged work, so removal is forced. As a hard safety net only
 * managed worktrees (`.vertragus-worktrees/` or legacy `.orca-worktrees/`) and
 * managed branches (`vertragus/` or legacy `orca/`) are ever touched — the main
 * checkout and user branches are never affected. Every Git failure is swallowed
 * (best-effort cleanup); returns true when the worktree or its branch was
 * actually removed.
 */
export async function rollbackWorktree(
  worktreePath: string,
  branch?: string
): Promise<boolean> {
  const path = worktreePath.trim()
  if (!path || !isManagedWorktreePath(path)) return false

  const root = await mainWorktreeRoot(path)
  if (!root) return false

  let removed = false
  try {
    await git(root, ['worktree', 'remove', '--force', path])
    removed = true
  } catch {
    // The checkout may already be gone or locked; still try the branch + prune.
  }

  if (branch && isManagedBranch(branch)) {
    try {
      await git(root, ['branch', '-D', branch])
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

  return removed
}
