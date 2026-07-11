/**
 * Lightweight git context for the title bar (repo path + branch pill).
 */
import type { GitInfo } from '@shared/ipc'
import { currentBranch, repoRoot } from '@main/agents/worktree'

export async function gitInfo(dir: string): Promise<GitInfo> {
  if (!dir?.trim()) return { isRepo: false }
  const root = await repoRoot(dir)
  if (!root) return { isRepo: false }
  const branch = await currentBranch(root)
  return { isRepo: true, root, branch: branch ?? undefined }
}
