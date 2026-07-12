/**
 * Lightweight git context for the title bar (repo path + branch pill).
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { GitInfo } from '@shared/ipc'
import { currentBranch, repoRoot } from '@main/agents/worktree'

const execFileAsync = promisify(execFile)

async function optionalGit(cwd: string, args: string[]): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', cwd, ...args], {
      windowsHide: true,
      timeout: 8000
    })
    return stdout.trim() || undefined
  } catch {
    return undefined
  }
}

export async function gitInfo(dir: string): Promise<GitInfo> {
  if (!dir?.trim()) return { isRepo: false }
  const root = await repoRoot(dir)
  if (!root) return { isRepo: false }
  const [branch, head, remote, defaultRef, status] = await Promise.all([
    currentBranch(root),
    optionalGit(root, ['rev-parse', 'HEAD']),
    optionalGit(root, ['remote', 'get-url', 'origin']),
    optionalGit(root, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']),
    optionalGit(root, ['status', '--porcelain=v1'])
  ])
  return {
    isRepo: true,
    root,
    branch: branch ?? undefined,
    head,
    remote,
    defaultBranch: defaultRef?.replace(/^origin\//, ''),
    dirty: Boolean(status)
  }
}
