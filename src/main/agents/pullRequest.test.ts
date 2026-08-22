import { execFile } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  commitsAhead,
  currentBranch,
  githubCompareUrl,
  openPullRequest,
  pullRequestBody,
  pullRequestTitle,
  type GhRunner
} from './pullRequest'
import type { GitRunner } from './worktree'

const execFileAsync = promisify(execFile)

/**
 * A real repository for the read-only git facts (branch name, commits ahead) —
 * those are exactly the answers a stub would get subtly wrong. The push and
 * `gh` calls run against injected runners: no test may ever reach a remote.
 */
let repoPath: string

async function git(args: string[], cwd = repoPath): Promise<void> {
  await execFileAsync('git', args, { cwd, windowsHide: true })
}

beforeAll(async () => {
  repoPath = mkdtempSync(join(tmpdir(), 'vertragus-pr-'))
  await git(['init', '-b', 'main'])
  await git(['config', 'user.email', 'test@vertragus.local'])
  await git(['config', 'user.name', 'Vertragus Test'])
  await git(['config', 'commit.gpgsign', 'false'])
  writeFileSync(join(repoPath, 'README.md'), '# fixture\n')
  await git(['add', '.'])
  await git(['commit', '-m', 'fixture'])
  await git(['checkout', '-b', 'vertragus/paradiso/virgilio'])
  writeFileSync(join(repoPath, 'feature.txt'), 'work\n')
  await git(['add', '.'])
  await git(['commit', '-m', 'the work'])
  await git(['checkout', 'main'])
}, 60_000)

afterAll(() => {
  if (repoPath) rmSync(repoPath, { recursive: true, force: true })
})

describe('git facts', () => {
  it('reads the branch the checkout is on', async () => {
    await expect(currentBranch(repoPath)).resolves.toBe('main')
  })

  it('counts what the head branch has and the base does not', async () => {
    await expect(commitsAhead(repoPath, 'main', 'vertragus/paradiso/virgilio')).resolves.toBe(1)
    await expect(commitsAhead(repoPath, 'vertragus/paradiso/virgilio', 'main')).resolves.toBe(0)
  })

  it('answers undefined — not zero — for a ref git cannot resolve', async () => {
    // The difference matters: "no commits" means do not open a PR, "no answer"
    // must never be read as that.
    await expect(commitsAhead(repoPath, 'main', 'does/not/exist')).resolves.toBeUndefined()
  })
})

describe('compare url', () => {
  it('builds one for both GitHub remote spellings', () => {
    expect(githubCompareUrl('git@github.com:Nehmo101/Vertragus.git', 'main', 'feature')).toBe(
      'https://github.com/Nehmo101/Vertragus/compare/main...feature?expand=1'
    )
    expect(githubCompareUrl('https://github.com/Nehmo101/Vertragus', 'main', 'feature')).toBe(
      'https://github.com/Nehmo101/Vertragus/compare/main...feature?expand=1'
    )
  })

  it('stays silent for a non-GitHub remote instead of inventing a link', () => {
    expect(githubCompareUrl('git@gitlab.com:someone/thing.git', 'main', 'feature')).toBeUndefined()
    expect(githubCompareUrl('/srv/git/bare.git', 'main', 'feature')).toBeUndefined()
  })
})

describe('pull request text', () => {
  it('titles the PR with the goal’s first line, and falls back to the workspace', () => {
    expect(
      pullRequestTitle({ workspaceName: 'Paradiso II', goal: 'Fix the panel\nand the rest' })
    ).toBe('Fix the panel')
    expect(pullRequestTitle({ workspaceName: 'Paradiso II' })).toBe('Vertragus run Paradiso II')
  })

  it('builds a body out of host facts only', () => {
    const body = pullRequestBody({
      workspaceName: 'Paradiso II',
      goal: 'Fix the panel',
      summary: 'Two agents, one fix, tests green.',
      branches: ['vertragus/paradiso/caronte']
    })
    expect(body).toContain('Fix the panel')
    expect(body).toContain('Two agents, one fix, tests green.')
    expect(body).toContain('`vertragus/paradiso/caronte`')
  })
})

interface Calls {
  git: string[][]
  gh: string[][]
}

function runners(options: {
  ghStdout?: string
  ghError?: unknown
  pushError?: unknown
  remoteUrl?: string
}): { calls: Calls; git: GitRunner; gh: GhRunner } {
  const calls: Calls = { git: [], gh: [] }
  const git: GitRunner = async (args) => {
    calls.git.push(args)
    if (args[0] === 'push' && options.pushError) throw options.pushError
    if (args[0] === 'remote') {
      return { stdout: options.remoteUrl ?? 'git@github.com:Nehmo101/Vertragus.git', stderr: '' }
    }
    return { stdout: '', stderr: '' }
  }
  const gh: GhRunner = async (args) => {
    calls.gh.push(args)
    if (options.ghError) throw options.ghError
    return { stdout: options.ghStdout ?? '', stderr: '' }
  }
  return { calls, git, gh }
}

const input = {
  repoPath: '/repo',
  head: 'vertragus/paradiso/virgilio',
  base: 'main',
  remote: 'origin',
  title: 'Fix the panel',
  body: 'body'
}

describe('openPullRequest', () => {
  it('pushes the branch and returns the URL gh printed', async () => {
    const { calls, git, gh } = runners({
      ghStdout: 'https://github.com/Nehmo101/Vertragus/pull/42\n'
    })
    await expect(openPullRequest({ ...input, draft: true }, { git, gh })).resolves.toEqual({
      ok: true,
      url: 'https://github.com/Nehmo101/Vertragus/pull/42',
      created: true
    })
    expect(calls.git[0]).toEqual(['push', '-u', 'origin', 'vertragus/paradiso/virgilio'])
    expect(calls.gh[0]).toContain('--draft')
    // Never a force push — the rule the whole merge path rests on.
    expect(calls.git.flat()).not.toContain('--force')
  })

  it('reports a rejected push and never opens a pull request for it', async () => {
    const { calls, git, gh } = runners({
      pushError: { stderr: '! [rejected] vertragus/paradiso/virgilio -> non-fast-forward' }
    })
    const outcome = await openPullRequest(input, { git, gh })
    expect(outcome).toMatchObject({ ok: false, reason: 'push_failed' })
    expect(calls.gh).toHaveLength(0)
  })

  it('turns a missing gh into the compare link instead of a failed run', async () => {
    const { git, gh } = runners({ ghError: Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' }) })
    const outcome = await openPullRequest(input, { git, gh })
    expect(outcome).toEqual({
      ok: false,
      reason: 'gh_missing',
      message: expect.stringContaining('GitHub CLI'),
      compareUrl:
        'https://github.com/Nehmo101/Vertragus/compare/main...vertragus%2Fparadiso%2Fvirgilio?expand=1'
    })
  })

  it('treats "a pull request already exists" as the pull request it names', async () => {
    const { git, gh } = runners({
      ghError: {
        stderr:
          'a pull request for branch "vertragus/paradiso/virgilio" already exists: https://github.com/Nehmo101/Vertragus/pull/7'
      }
    })
    await expect(openPullRequest(input, { git, gh })).resolves.toEqual({
      ok: true,
      url: 'https://github.com/Nehmo101/Vertragus/pull/7',
      created: false
    })
  })

  it('asks gh for the existing PR when the refusal names no URL', async () => {
    const gh = vi
      .fn<GhRunner>()
      .mockRejectedValueOnce({ stderr: 'a pull request already exists for this branch' })
      .mockResolvedValueOnce({ stdout: 'https://github.com/Nehmo101/Vertragus/pull/9\n', stderr: '' })
    const { git } = runners({})
    await expect(openPullRequest(input, { git, gh })).resolves.toEqual({
      ok: true,
      url: 'https://github.com/Nehmo101/Vertragus/pull/9',
      created: false
    })
    expect(gh.mock.calls[1]?.[0]).toEqual([
      'pr',
      'view',
      'vertragus/paradiso/virgilio',
      '--json',
      'url',
      '-q',
      '.url'
    ])
  })

  it('reports a gh failure with its own words plus the compare link', async () => {
    const { git, gh } = runners({ ghError: { stderr: 'GraphQL: Resource not accessible' } })
    const outcome = await openPullRequest(input, { git, gh })
    expect(outcome).toMatchObject({
      ok: false,
      reason: 'gh_failed',
      message: 'GraphQL: Resource not accessible'
    })
    expect((outcome as { compareUrl?: string }).compareUrl).toContain('/compare/main...')
  })
})
