import type { ExecutionPlanResult } from '@shared/orchestrator'
import type { WorkspaceGitPostProcessingSnapshot } from '@shared/gitPostProcessing'
import { profileRepoLocalPath, type WorkspaceProfile } from '@shared/profile'
import {
  postProcessWorkspaceGit,
  type GitPostProcessResult,
  type GitPostProcessInput
} from '@main/integrations/gitPostProcessing'

export type WorkspaceTerminalStatus = ExecutionPlanResult['status']
export type WorkspaceGitPostProcessor = (input: GitPostProcessInput) => Promise<GitPostProcessResult>

export interface WorkspaceRunLifecycleInput {
  planId: string
  status: WorkspaceTerminalStatus
  goal: string
  profile?: WorkspaceProfile
  postProcess?: WorkspaceGitPostProcessor
  onGitState?: (state: WorkspaceGitPostProcessingSnapshot) => void
}

export interface WorkspaceRunLifecycleResult {
  status: WorkspaceTerminalStatus
  gitPostProcessing?: WorkspaceGitPostProcessingSnapshot
}

export function workspaceCommitMessage(goal: string): string {
  const withoutControls = [...goal].map((character) => {
    const code = character.charCodeAt(0)
    return code <= 31 || code === 127 ? ' ' : character
  }).join('')
  const normalized = withoutControls
    .replace(/\s+/g, ' ')
    .trim()
  return `Orca-Strator: ${normalized || 'Workspace-Bearbeitung abgeschlossen'}`
    .slice(0, 500)
    .trim()
}

function completedSnapshot(
  planId: string,
  startedAt: number,
  result: GitPostProcessResult
): WorkspaceGitPostProcessingSnapshot {
  return {
    planId,
    status: result.status,
    targetBranch: result.targetBranch,
    changedFiles: [...result.changedFiles],
    startedAt,
    finishedAt: Date.now(),
    sourceBranch: result.sourceBranch,
    commit: result.commit,
    error: result.status === 'failed'
      ? {
          code: result.error.code,
          phase: result.error.phase,
          message: result.error.message,
          detail: result.error.detail,
          mutation: result.error.mutation
        }
      : undefined
  }
}

/**
 * The only lifecycle gate for profile Auto-Git. Stopped, incomplete and failed
 * domain work never reaches Git mutation. A Git failure downgrades an otherwise
 * successful run to error so the UI cannot show a false green completion.
 */
export async function finalizeWorkspaceRun(
  input: WorkspaceRunLifecycleInput
): Promise<WorkspaceRunLifecycleResult> {
  const config = input.profile?.autoGit
  if (input.status !== 'success' || !input.profile || !config?.enabled) {
    return { status: input.status }
  }

  const startedAt = Date.now()
  const running: WorkspaceGitPostProcessingSnapshot = {
    planId: input.planId,
    status: 'running',
    targetBranch: config.targetBranch,
    changedFiles: [],
    startedAt
  }
  input.onGitState?.(running)

  let completed: WorkspaceGitPostProcessingSnapshot
  try {
    const result = await (input.postProcess ?? postProcessWorkspaceGit)({
      workspaceDir: profileRepoLocalPath(input.profile),
      targetBranch: config.targetBranch,
      commitMessage: workspaceCommitMessage(input.goal)
    })
    completed = completedSnapshot(input.planId, startedAt, result)
  } catch {
    completed = {
      ...running,
      status: 'failed',
      finishedAt: Date.now(),
      error: {
        code: 'UNEXPECTED_GIT_POST_PROCESSING_ERROR',
        phase: 'unexpected',
        message: 'Git-Post-Processing ist unerwartet fehlgeschlagen.',
        mutation: 'unknown'
      }
    }
  }
  input.onGitState?.(completed)
  return {
    status: completed.status === 'failed' ? 'error' : 'success',
    gitPostProcessing: completed
  }
}
