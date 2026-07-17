import { chmod, mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createWorkspaceGitPostProcessor,
  isValidPostProcessBranch,
  postProcessWorkspaceGit,
  type GitCommandResult
} from './gitPostProcessing'
import { GitTestHarness } from './gitTestHarness'

const gitHarness = new GitTestHarness()

async function git(cwd: string, ...args: string[]): Promise<string> {
  return gitHarness.git(cwd, '-C', cwd, ...args)
}

describe('orchestrator Git post-processing', () => {
  let fixtureRoot: string
  let workspaceDir: string
  let remoteDir: string

  beforeEach(async () => {
    fixtureRoot = await mkdtemp(join(tmpdir(), 'orca-git-post-process-'))
    workspaceDir = join(fixtureRoot, 'workspace')
    remoteDir = join(fixtureRoot, 'remote.git')

    await mkdir(workspaceDir)
    await git(workspaceDir, 'init')
    await git(workspaceDir, 'config', 'user.email', 'test@orca.local')
    await git(workspaceDir, 'config', 'user.name', 'Orca Test')
    await writeFile(join(workspaceDir, 'README.md'), '# initial\n', 'utf8')
    await writeFile(join(workspaceDir, 'obsolete.txt'), 'remove me\n', 'utf8')
    await git(workspaceDir, 'add', '--all')
    await git(workspaceDir, 'commit', '-m', 'initial')
    await git(workspaceDir, 'branch', '-M', 'main')

    await git(fixtureRoot, 'init', '--bare', remoteDir)
    await git(workspaceDir, 'remote', 'add', 'origin', remoteDir)
    await git(workspaceDir, 'push', 'origin', 'main')
  })

  afterEach(async () => {
    await gitHarness.cleanup([fixtureRoot])
  }, 20_000)

  it('returns clean without requiring an attached HEAD or remote', async () => {
    await git(workspaceDir, 'checkout', '--detach')
    await git(workspaceDir, 'remote', 'remove', 'origin')
    const before = await git(workspaceDir, 'rev-parse', 'HEAD')

    const result = await postProcessWorkspaceGit({
      workspaceDir,
      targetBranch: 'orca/result',
      commitMessage: 'Orca result'
    })

    expect(result).toEqual(expect.objectContaining({
      ok: true,
      status: 'clean',
      changedFiles: [],
      targetBranch: 'orca/result'
    }))
    expect(await git(workspaceDir, 'rev-parse', 'HEAD')).toBe(before)
  }, 20_000)

  it('commits all relevant workspace changes and pushes only to the explicit target branch', async () => {
    await writeFile(join(workspaceDir, 'README.md'), '# changed\n', 'utf8')
    await writeFile(join(workspaceDir, 'new file.txt'), 'new\n', 'utf8')
    await git(workspaceDir, 'rm', 'obsolete.txt')

    const result = await postProcessWorkspaceGit({
      workspaceDir,
      targetBranch: 'orca/task-83',
      commitMessage: 'Apply orchestrator result'
    })

    expect(result).toEqual(expect.objectContaining({
      ok: true,
      status: 'pushed',
      sourceBranch: 'main',
      targetBranch: 'orca/task-83',
      remote: 'origin',
      changedFiles: ['README.md', 'new file.txt', 'obsolete.txt']
    }))
    if (result.status !== 'pushed') throw new Error('expected pushed result')
    expect(await git(workspaceDir, 'status', '--porcelain=v1')).toBe('')
    expect(await git(fixtureRoot, '--git-dir', remoteDir, 'rev-parse', 'refs/heads/orca/task-83'))
      .toBe(result.commit)
    await expect(git(fixtureRoot, '--git-dir', remoteDir, 'rev-parse', 'refs/heads/main'))
      .resolves.not.toBe(result.commit)
  }, 20_000)

  it('rejects malicious branch names before any Git command can run', async () => {
    const runGit = vi.fn<(cwd: string, args: readonly string[]) => Promise<GitCommandResult>>()
    const processGit = createWorkspaceGitPostProcessor({ runGit })
    const invalidBranches = [
      '--force',
      '-c/core.sshCommand=payload',
      'main:refs/heads/injected',
      'main\n--force',
      'feature/../../main',
      'feature/@{upstream}',
      'feature name',
      'main;touch-injected',
      '$(touch-injected)',
      'release.lock',
      'HEAD',
      'head',
      'main\\injected'
    ]

    for (const targetBranch of invalidBranches) {
      expect(isValidPostProcessBranch(targetBranch)).toBe(false)
      await expect(processGit({ workspaceDir, targetBranch, commitMessage: 'safe' }))
        .resolves.toEqual(expect.objectContaining({
          ok: false,
          error: expect.objectContaining({ code: 'INVALID_TARGET_BRANCH', phase: 'validation' })
        }))
    }
    expect(runGit).not.toHaveBeenCalled()
  })

  it('passes commit text and the push refspec as isolated arguments without argument injection', async () => {
    const calls: string[][] = []
    const injectedCommitText = '--amend --no-verify; touch injected'
    const runGit = vi.fn(async (_cwd: string, args: readonly string[]): Promise<GitCommandResult> => {
      calls.push([...args])
      const command = args.join('\0')
      if (command === ['rev-parse', '--show-toplevel'].join('\0')) {
        return { stdout: `${workspaceDir}\n`, stderr: '' }
      }
      if (args[0] === 'status') return { stdout: ' M README.md\0', stderr: '' }
      if (args[0] === 'symbolic-ref') return { stdout: 'main\n', stderr: '' }
      if (args[0] === 'diff') return { stdout: 'README.md\0', stderr: '' }
      if (command === ['rev-parse', '--verify', 'HEAD^{commit}'].join('\0')) {
        return { stdout: `${'a'.repeat(40)}\n`, stderr: '' }
      }
      return { stdout: '', stderr: '' }
    })
    const processGit = createWorkspaceGitPostProcessor({ runGit })

    const result = await processGit({
      workspaceDir,
      targetBranch: 'orca/safe-target',
      commitMessage: injectedCommitText
    })

    expect(result.status).toBe('pushed')
    expect(calls).toContainEqual(['commit', '-m', injectedCommitText, '--'])
    expect(calls.at(-1)).toEqual([
      'push',
      '--porcelain',
      '--',
      'origin',
      'HEAD:refs/heads/orca/safe-target'
    ])
  })

  it('rejects malformed or relative workspace paths before invoking Git', async () => {
    const runGit = vi.fn<(cwd: string, args: readonly string[]) => Promise<GitCommandResult>>()
    const processGit = createWorkspaceGitPostProcessor({ runGit })

    for (const invalidWorkspace of [
      `${workspaceDir} `,
      'relative/../workspace',
      `${workspaceDir}\0injected`
    ]) {
      const result = await processGit({
        workspaceDir: invalidWorkspace,
        targetBranch: 'orca/result',
        commitMessage: 'Safe message'
      })
      expect(result).toEqual(expect.objectContaining({
        ok: false,
        error: expect.objectContaining({ code: 'INVALID_WORKSPACE', phase: 'validation' })
      }))
    }
    expect(runGit).not.toHaveBeenCalled()
  })

  it('rejects a nested path traversal workspace boundary without staging parent files', async () => {
    const nested = join(workspaceDir, 'nested')
    await mkdir(nested)
    await writeFile(join(workspaceDir, 'outside-nested.txt'), 'must remain unstaged\n', 'utf8')

    const result = await postProcessWorkspaceGit({
      workspaceDir: nested,
      targetBranch: 'orca/result',
      commitMessage: 'Must not commit parent files'
    })

    expect(result).toEqual(expect.objectContaining({
      ok: false,
      error: expect.objectContaining({ code: 'WORKSPACE_NOT_ROOT', mutation: 'none' })
    }))
    expect(await git(workspaceDir, 'diff', '--cached', '--name-only')).toBe('')
    expect(await git(workspaceDir, 'status', '--porcelain=v1')).toContain('outside-nested.txt')
  }, 20_000)

  it('reports detached HEAD deterministically and leaves dirty changes untouched', async () => {
    await git(workspaceDir, 'checkout', '--detach')
    await writeFile(join(workspaceDir, 'README.md'), '# detached change\n', 'utf8')
    const before = await git(workspaceDir, 'rev-parse', 'HEAD')

    const result = await postProcessWorkspaceGit({
      workspaceDir,
      targetBranch: 'orca/result',
      commitMessage: 'Must not commit detached work'
    })

    expect(result).toEqual(expect.objectContaining({
      ok: false,
      changedFiles: ['README.md'],
      error: expect.objectContaining({
        code: 'DETACHED_HEAD',
        phase: 'precondition',
        mutation: 'none'
      })
    }))
    expect(await git(workspaceDir, 'rev-parse', 'HEAD')).toBe(before)
    expect(await git(workspaceDir, 'diff', '--cached', '--name-only')).toBe('')
  }, 20_000)

  it('reports a missing remote before staging or committing', async () => {
    await git(workspaceDir, 'remote', 'remove', 'origin')
    await writeFile(join(workspaceDir, 'README.md'), '# no remote\n', 'utf8')
    const before = await git(workspaceDir, 'rev-parse', 'HEAD')

    const result = await postProcessWorkspaceGit({
      workspaceDir,
      targetBranch: 'orca/result',
      commitMessage: 'Must not commit without remote'
    })

    expect(result).toEqual(expect.objectContaining({
      ok: false,
      sourceBranch: 'main',
      changedFiles: ['README.md'],
      error: expect.objectContaining({ code: 'REMOTE_MISSING', mutation: 'none' })
    }))
    expect(await git(workspaceDir, 'rev-parse', 'HEAD')).toBe(before)
    expect(await git(workspaceDir, 'diff', '--cached', '--name-only')).toBe('')
  }, 20_000)

  it('returns a structured commit failure and preserves staged changes', async () => {
    const hook = join(workspaceDir, '.git', 'hooks', 'pre-commit')
    await writeFile(hook, '#!/bin/sh\necho "blocked by test hook" >&2\nexit 1\n', 'utf8')
    await chmod(hook, 0o755)
    await writeFile(join(workspaceDir, 'README.md'), '# hook rejection\n', 'utf8')
    const before = await git(workspaceDir, 'rev-parse', 'HEAD')

    const result = await postProcessWorkspaceGit({
      workspaceDir,
      targetBranch: 'orca/result',
      commitMessage: 'Rejected commit'
    })

    expect(result).toEqual(expect.objectContaining({
      ok: false,
      changedFiles: ['README.md'],
      error: expect.objectContaining({
        code: 'COMMIT_FAILED',
        phase: 'commit',
        mutation: 'staged',
        detail: expect.stringContaining('blocked by test hook')
      })
    }))
    expect(await git(workspaceDir, 'rev-parse', 'HEAD')).toBe(before)
    expect(await git(workspaceDir, 'diff', '--cached', '--name-only')).toBe('README.md')
  }, 20_000)

  it('returns the local commit when the remote rejects the push', async () => {
    const hook = join(remoteDir, 'hooks', 'pre-receive')
    await writeFile(hook, '#!/bin/sh\necho "remote policy rejection" >&2\nexit 1\n', 'utf8')
    await chmod(hook, 0o755)
    await writeFile(join(workspaceDir, 'README.md'), '# rejected push\n', 'utf8')
    const remoteBefore = await git(fixtureRoot, '--git-dir', remoteDir, 'rev-parse', 'refs/heads/main')

    const result = await postProcessWorkspaceGit({
      workspaceDir,
      targetBranch: 'main',
      commitMessage: 'Locally committed result'
    })

    expect(result).toEqual(expect.objectContaining({
      ok: false,
      sourceBranch: 'main',
      commit: expect.stringMatching(/^[a-f0-9]{40}$/),
      error: expect.objectContaining({
        code: 'PUSH_REJECTED',
        phase: 'push',
        mutation: 'committed',
        retryable: false
      })
    }))
    expect(await git(workspaceDir, 'status', '--porcelain=v1')).toBe('')
    expect(await git(workspaceDir, 'rev-parse', 'HEAD')).toBe(result.commit)
    expect(await git(fixtureRoot, '--git-dir', remoteDir, 'rev-parse', 'refs/heads/main'))
      .toBe(remoteBefore)
  }, 20_000)

  // macOS tmpdirs live behind a symlink (/var -> /private/var) and Windows
  // uses 8.3 short paths; the root guard must compare canonical paths.
  it.skipIf(process.platform === 'win32')(
    'accepts a symlinked alias of the workspace root instead of rejecting it as non-root',
    async () => {
      const alias = join(fixtureRoot, 'workspace-alias')
      await symlink(workspaceDir, alias, 'dir')
      await writeFile(join(alias, 'README.md'), '# via alias\n', 'utf8')

      const result = await postProcessWorkspaceGit({
        workspaceDir: alias,
        targetBranch: 'main',
        commitMessage: 'Committed through a path alias'
      })

      expect(result.ok).toBe(true)
      expect(result.status).toBe('pushed')
    },
    20_000
  )

  it('redacts credentials from structured Git error details without leaking a secret', async () => {
    const privateValue = 'very-private-value'
    const runGit = vi.fn(async (_cwd: string, args: readonly string[]): Promise<GitCommandResult> => {
      if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') {
        return { stdout: workspaceDir, stderr: '' }
      }
      if (args[0] === 'status') return { stdout: ' M README.md\0', stderr: '' }
      if (args[0] === 'symbolic-ref') return { stdout: 'main', stderr: '' }
      if (args[0] === 'diff') return { stdout: 'README.md\0', stderr: '' }
      if (args[0] === 'rev-parse') return { stdout: 'b'.repeat(40), stderr: '' }
      if (args[0] === 'push') {
        throw { stderr: `fatal: https://user:${privateValue}@example.test/repo rejected` }
      }
      return { stdout: '', stderr: '' }
    })

    const result = await createWorkspaceGitPostProcessor({ runGit })({
      workspaceDir,
      targetBranch: 'orca/result',
      commitMessage: 'Redaction test'
    })

    expect(result.status).toBe('failed')
    if (result.status !== 'failed') throw new Error('expected failed result')
    expect(result.error.detail).toContain('[redacted]@example.test')
    expect(result.error.detail).not.toContain(privateValue)
  })

  it('serializes concurrent operations so only one commit and push is created', async () => {
    await writeFile(join(workspaceDir, 'README.md'), '# concurrent result\n', 'utf8')
    const processGit = createWorkspaceGitPostProcessor()

    const [first, second] = await Promise.all([
      processGit({ workspaceDir, targetBranch: 'orca/concurrent', commitMessage: 'First call' }),
      processGit({ workspaceDir, targetBranch: 'orca/concurrent', commitMessage: 'Second call' })
    ])

    expect(first.status).toBe('pushed')
    expect(second.status).toBe('clean')
    expect(await git(workspaceDir, 'rev-list', '--count', 'HEAD')).toBe('2')
    expect(await git(workspaceDir, 'log', '-1', '--pretty=%s')).toBe('First call')
  }, 20_000)
})
