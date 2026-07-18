/**
 * Git worktree isolation: each agent gets its own worktree + branch so
 * parallel (especially Yolo) agents never collide in the same checkout.
 *
 * Worktrees live under <repoRoot>/.orca-worktrees/<sessionId>/<agentId> on
 * branch orca/<sessionId>/<agentId>. Stopping a single agent keeps its worktree
 * so its work can still be inspected; killing (removing) a whole workspace run
 * rolls the agents back via `rollbackWorktree`, discarding the isolated
 * checkout and its branch.
 */
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
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
    path: join(root, '.orca-worktrees', safeSession, safeAgent),
    branch: `orca/${safeSession}/${safeAgent}`
  }
}

/**
 * Create a fresh isolated worktree for the given agent and app session.
 * A non-Git directory returns null. Git failures are surfaced to the caller;
 * falling back to a shared checkout would silently disable isolation.
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
  const identity = worktreeIdentity(root, agentId, sessionId)
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

/** Only ever touch paths Orca created under `.orca-worktrees/`. */
export function isOrcaWorktreePath(path: string): boolean {
  return /[\\/]\.orca-worktrees[\\/]/.test(path.trim())
}

/** Only ever delete branches Orca created under the `orca/` namespace. */
export function isOrcaBranch(branch: string): boolean {
  return /^orca\//.test(branch.trim())
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
 * Roll back (discard) an Orca-managed isolated worktree and its branch.
 *
 * Rolling back a killed workspace deliberately throws away the agent's
 * uncommitted, unmerged work, so removal is forced. As a hard safety net only
 * worktrees under `.orca-worktrees/` and branches under `orca/` are ever
 * touched — the main checkout and user branches are never affected. Every Git
 * failure is swallowed (best-effort cleanup); returns true when the worktree or
 * its branch was actually removed.
 */
export async function rollbackWorktree(
  worktreePath: string,
  branch?: string
): Promise<boolean> {
  const path = worktreePath.trim()
  if (!path || !isOrcaWorktreePath(path)) return false

  const root = await mainWorktreeRoot(path)
  if (!root) return false

  let removed = false
  try {
    await git(root, ['worktree', 'remove', '--force', path])
    removed = true
  } catch {
    // The checkout may already be gone or locked; still try the branch + prune.
  }

  if (branch && isOrcaBranch(branch)) {
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
