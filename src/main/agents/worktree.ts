/**
 * Git worktree isolation: each agent gets its own worktree + branch so
 * parallel (especially Yolo) agents never collide in the same checkout.
 *
 * Worktrees live under <repoRoot>/.orca-worktrees/<agentId> on branch
 * orca/<agentId>. They are left in place when an agent stops (no data loss);
 * cleanup tooling comes with the diff/merge view in Phase 2.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'

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

/** Create (or reuse) an isolated worktree for the given agent id. */
export async function createWorktree(dir: string, agentId: string): Promise<WorktreeResult | null> {
  const root = await repoRoot(dir)
  if (!root) return null
  const path = join(root, '.orca-worktrees', agentId)
  const branch = `orca/${agentId}`
  try {
    await git(root, ['worktree', 'add', '-b', branch, path])
    return { path, branch }
  } catch {
    // Branch/dir may already exist from a previous run — try plain checkout.
    try {
      await git(root, ['worktree', 'add', path, branch])
      return { path, branch }
    } catch {
      return null
    }
  }
}
