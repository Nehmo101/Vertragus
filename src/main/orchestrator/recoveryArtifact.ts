import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { TaskRecoveryArtifact } from '@shared/orchestrator'
import { isExactOrcaWorktreePath } from '@main/agents/cursorWorkspaceTrust'
import { canonicalWorkspacePath, workspacePathKey } from '@main/agents/workspacePath'

const execFileAsync = promisify(execFile)
const RECOVERY_TIMEOUT_MS = 15_000
const MAX_STATUS_LINES = 40
const MAX_STATUS_CHARS = 4_000

function statusPath(line: string): string | undefined {
  const payload = line.slice(3).trim()
  if (!payload) return undefined
  const renamed = payload.includes(' -> ') ? payload.split(' -> ').at(-1)! : payload
  return renamed.replace(/^"|"$/g, '')
}

export function recoveryFilesFromStatus(status: string): string[] {
  return [...new Set(
    status
      .split(/\r?\n/)
      .filter(Boolean)
      .map(statusPath)
      .filter((file): file is string => Boolean(file))
  )]
}

export async function captureTaskRecoveryArtifact(input: {
  worktree?: string
  baseCommit?: string
}): Promise<TaskRecoveryArtifact | undefined> {
  const requested = input.worktree
  if (!requested || !isExactOrcaWorktreePath(requested)) return undefined
  try {
    const worktree = await canonicalWorkspacePath(requested)
    if (
      !isExactOrcaWorktreePath(worktree) ||
      workspacePathKey(worktree) !== workspacePathKey(requested)
    ) {
      return undefined
    }
    const { stdout } = await execFileAsync(
      'git',
      ['-C', worktree, 'status', '--porcelain=v1', '--untracked-files=all'],
      { windowsHide: true, timeout: RECOVERY_TIMEOUT_MS }
    )
    const lines = stdout.split(/\r?\n/).filter(Boolean)
    if (lines.length === 0) return undefined
    return {
      worktree,
      baseCommit: input.baseCommit,
      changedFiles: recoveryFilesFromStatus(stdout),
      statusSummary: lines.slice(0, MAX_STATUS_LINES).join('\n').slice(0, MAX_STATUS_CHARS),
      capturedAt: Date.now()
    }
  } catch {
    // Recovery capture must never replace the worker's original failure.
    return undefined
  }
}
