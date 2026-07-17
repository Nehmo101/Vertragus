import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_PROFILE } from '@shared/profile'
import { finalizeWorkspaceRun, workspaceCommitMessage } from './workspaceRunLifecycle'

const enabledProfile = {
  ...DEFAULT_PROFILE,
  workingDir: 'C:\\repo',
  autoGit: { enabled: true, targetBranch: 'orca/integrated' }
}

describe('workspace run lifecycle', () => {
  it.each(['needs-work', 'error', 'stopped'] as const)(
    'does not mutate Git after a %s domain result',
    async (status) => {
      const postProcess = vi.fn()
      await expect(finalizeWorkspaceRun({
        planId: 'plan-1',
        status,
        goal: 'Unsuccessful',
        profile: enabledProfile,
        postProcess
      })).resolves.toEqual({ status })
      expect(postProcess).not.toHaveBeenCalled()
    }
  )

  it('keeps disabled Auto-Git as a successful no-op', async () => {
    const postProcess = vi.fn()
    await expect(finalizeWorkspaceRun({
      planId: 'plan-1',
      status: 'success',
      goal: 'Done',
      profile: DEFAULT_PROFILE,
      postProcess
    })).resolves.toEqual({ status: 'success' })
    expect(postProcess).not.toHaveBeenCalled()
  })

  it.each(['clean', 'pushed'] as const)('keeps a %s Git result green', async (gitStatus) => {
    const states: string[] = []
    const postProcess = vi.fn().mockResolvedValue({
      ok: true,
      status: gitStatus,
      workspaceDir: enabledProfile.workingDir,
      targetBranch: enabledProfile.autoGit.targetBranch,
      remote: 'origin',
      changedFiles: gitStatus === 'clean' ? [] : ['src/feature.ts'],
      ...(gitStatus === 'pushed' ? { sourceBranch: 'main', commit: 'a'.repeat(40) } : {})
    })

    const result = await finalizeWorkspaceRun({
      planId: 'plan-1',
      status: 'success',
      goal: 'Implement feature',
      profile: enabledProfile,
      postProcess,
      onGitState: (state) => states.push(state.status)
    })

    expect(result.status).toBe('success')
    expect(result.gitPostProcessing?.status).toBe(gitStatus)
    expect(states).toEqual(['running', gitStatus])
    expect(postProcess).toHaveBeenCalledWith({
      workspaceDir: enabledProfile.workingDir,
      targetBranch: 'orca/integrated',
      commitMessage: 'Vertragus: Implement feature'
    })
  })

  it('turns a push failure into a terminal error with recovery metadata', async () => {
    const result = await finalizeWorkspaceRun({
      planId: 'plan-1',
      status: 'success',
      goal: 'Done',
      profile: enabledProfile,
      postProcess: vi.fn().mockResolvedValue({
        ok: false,
        status: 'failed',
        workspaceDir: enabledProfile.workingDir,
        targetBranch: 'orca/integrated',
        remote: 'origin',
        changedFiles: ['src/feature.ts'],
        sourceBranch: 'main',
        commit: 'b'.repeat(40),
        error: {
          code: 'PUSH_REJECTED',
          phase: 'push',
          message: 'Git-Push wurde abgewiesen oder ist fehlgeschlagen.',
          retryable: false,
          mutation: 'committed'
        }
      })
    })

    expect(result.status).toBe('error')
    expect(result.gitPostProcessing).toMatchObject({
      status: 'failed',
      commit: 'b'.repeat(40),
      error: { code: 'PUSH_REJECTED', mutation: 'committed' }
    })
  })

  it('normalizes control characters in generated commit subjects', () => {
    expect(workspaceCommitMessage('  Feature\n--amend\tready  ')).toBe(
      'Vertragus: Feature --amend ready'
    )
  })
})
