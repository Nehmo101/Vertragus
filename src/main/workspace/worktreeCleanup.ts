/**
 * The panel's worktree cleanup — listing and removing what agents left behind.
 *
 * Every agent run leaves its worktree under `<repo>/.vertragus/worktrees/`
 * (deliberately — see `agents/worktree`), so a repository that hosted a few
 * workspaces accumulates checkouts. This module decides which of them are
 * STALE: inside the Vertragus worktree root and not the working directory of
 * any live agent. The main checkout and foreign worktrees the user created
 * elsewhere are never candidates.
 *
 * Removal is guarded twice. Here: only a path from the current stale list is
 * accepted, so the panel (or a compromised renderer) can never remove the main
 * checkout, a live agent's worktree, or an arbitrary directory. In git: no
 * `--force`, so uncommitted changes make the removal fail loudly. Branches are
 * never deleted — committed work survives every cleanup.
 */
import { join } from 'node:path'
import { mainMessages } from '@shared/mainMessages'
import {
  listWorktrees,
  removeWorktree,
  WORKTREE_ROOT,
  type WorktreeDeps
} from '@main/agents/worktree'

/** One row of the panel's cleanup list. */
export interface StaleWorktreeSummary {
  path: string
  /** Short branch name; absent for a detached worktree. */
  branch?: string
}

export interface WorktreeCleanupDeps {
  /** Repo path of a profile, or undefined for an unknown profile id. */
  repoPathFor(profileId: string): string | undefined
  /** Working directories of every agent that is still alive, across ALL workspaces. */
  activeWorktreePaths(): string[]
  list?: typeof listWorktrees
  remove?: typeof removeWorktree
  worktreeDeps?: WorktreeDeps
  /**
   * Stored UI locale for the two refusals below — both reach the panel's error
   * row verbatim. A function, not a value, so a locale changed after boot is
   * honoured; absent (tests) falls back to the schema default.
   */
  locale?(): string | undefined
}

export interface WorktreeCleanup {
  /** Stale worktrees of this profile's repository, ready to render. */
  listStale(profileId: string): Promise<StaleWorktreeSummary[]>
  /** Remove ONE stale worktree; answers with the refreshed stale list. */
  remove(profileId: string, worktreePath: string): Promise<StaleWorktreeSummary[]>
}

/**
 * Separator- and trailing-slash-insensitive comparison key. `git worktree list`
 * prints forward slashes even on Windows, while everything Vertragus builds
 * with `join()` uses backslashes there — compared raw, every worktree would
 * look foreign to its own repository.
 */
export function worktreePathKey(value: string): string {
  return value.replace(/\\/g, '/').replace(/\/+$/, '')
}

export function createWorktreeCleanup(deps: WorktreeCleanupDeps): WorktreeCleanup {
  const list = deps.list ?? listWorktrees
  const remove = deps.remove ?? removeWorktree
  const messages = (): ReturnType<typeof mainMessages> => mainMessages(deps.locale?.())

  function requireRepoPath(profileId: string): string {
    const repoPath = deps.repoPathFor(profileId)
    if (!repoPath) throw new Error(messages().unknownProfile(profileId))
    return repoPath
  }

  async function listStale(profileId: string): Promise<StaleWorktreeSummary[]> {
    const repoPath = requireRepoPath(profileId)
    const rootPrefix = `${worktreePathKey(join(repoPath, WORKTREE_ROOT))}/`
    const active = new Set(deps.activeWorktreePaths().map(worktreePathKey))
    return (await list(repoPath, deps.worktreeDeps))
      .filter((entry) => {
        const key = worktreePathKey(entry.path)
        return key.startsWith(rootPrefix) && !active.has(key)
      })
      .map((entry) => ({ path: entry.path, ...(entry.branch ? { branch: entry.branch } : {}) }))
  }

  return {
    listStale,

    async remove(profileId, worktreePath) {
      const repoPath = requireRepoPath(profileId)
      // Membership in the CURRENT stale list is the authorization: anything
      // else — the main checkout, a live agent, a path outside the repo — is
      // refused before git ever sees it.
      const stale = await listStale(profileId)
      const key = worktreePathKey(worktreePath)
      const target = stale.find((entry) => worktreePathKey(entry.path) === key)
      if (!target) throw new Error(messages().worktreeNotRemovable(worktreePath))
      await remove(repoPath, target.path, deps.worktreeDeps)
      return listStale(profileId)
    }
  }
}
