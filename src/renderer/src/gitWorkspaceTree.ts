import type { GitInfo, GitWorktreeInfo } from '@shared/ipc'

export type GitWorkspaceTreeGate =
  | 'checking-auth'
  | 'needs-auth'
  | 'needs-binding'
  | 'needs-repo'
  | 'ready'

export interface GitBranchTreeNode {
  name: string
  current: boolean
  defaultBranch: boolean
  worktrees: GitWorktreeInfo[]
}

export interface GitBranchTree {
  branches: GitBranchTreeNode[]
  detachedWorktrees: GitWorktreeInfo[]
}

export function gitWorkspaceTreeGate(input: {
  authResolved: boolean
  githubUsable: boolean
  repoBound: boolean
  isRepo: boolean
}): GitWorkspaceTreeGate {
  if (!input.authResolved) return 'checking-auth'
  if (!input.githubUsable) return 'needs-auth'
  if (!input.repoBound) return 'needs-binding'
  if (!input.isRepo) return 'needs-repo'
  return 'ready'
}

export function buildGitBranchTree(gitInfo: GitInfo): GitBranchTree {
  const worktrees = gitInfo.worktrees ?? []
  const branchNames = new Set(gitInfo.branches ?? [])
  for (const worktree of worktrees) {
    if (worktree.branch && !worktree.detached) branchNames.add(worktree.branch)
  }

  const rank = (branch: string): number => {
    if (branch === gitInfo.branch) return 0
    if (branch === gitInfo.defaultBranch) return 1
    return 2
  }
  const branches = [...branchNames]
    .sort((left, right) => rank(left) - rank(right) || left.localeCompare(right))
    .map((name) => ({
      name,
      current: name === gitInfo.branch,
      defaultBranch: name === gitInfo.defaultBranch,
      worktrees: worktrees.filter((worktree) => !worktree.detached && worktree.branch === name)
    }))

  return {
    branches,
    detachedWorktrees: worktrees.filter((worktree) => !worktree.branch || worktree.detached)
  }
}

function normalizedPath(path: string): string {
  const value = path.replace(/\\/g, '/').replace(/\/$/, '')
  return /^[a-z]:\//i.test(value) ? value.toLowerCase() : value
}

export function compactWorktreePath(path: string, root?: string): string {
  if (root && normalizedPath(path) === normalizedPath(root)) return 'Haupt-Worktree'
  const parts = path.replace(/\\/g, '/').split('/').filter(Boolean)
  return parts.slice(-2).join(' / ') || path
}