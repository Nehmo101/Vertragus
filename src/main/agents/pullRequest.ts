/**
 * A3: the host's pull-request path — push one branch, open one PR.
 *
 * Vertragus never pushed anything before this module, and it still pushes
 * nothing on its own: the whole file only runs when the user ticked
 * `automation.autoPr` in the profile. The rules it inherits from
 * `worktree.ts` are the same ones that make the merge path trustworthy:
 *
 * 1. **No shell.** `git` and `gh` are invoked through `execFile` with an
 *    argument array — a branch name is data, and a shell string would make it
 *    executable.
 * 2. **No force, no history rewrite.** The push is a plain fast-forward push
 *    of the run's own `vertragus/*` branch. A rejected push is reported, never
 *    retried with `--force`.
 * 3. **Fail-soft.** A missing or logged-out `gh` is not a failed run: the
 *    outcome then carries the ready-made compare URL, so the user is one click
 *    away from the PR the host could not open itself.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import {
  defaultGitRunner,
  gitErrorMessage,
  type GitResult,
  type GitRunner,
  type WorktreeDeps
} from './worktree'

const execFileAsync = promisify(execFile)

/**
 * Network calls get a deadline: `git push` and `gh` reach the outside world,
 * and this path runs while the user is stopping a workspace. A hung transfer
 * must fail with a sentence, not hold the Stop button forever.
 */
export const PUSH_TIMEOUT_MS = 120_000
export const GH_TIMEOUT_MS = 60_000

/**
 * git for the network call. `GIT_TERMINAL_PROMPT=0` is the point: a `git push`
 * that wants a username has no terminal to ask on here, and without this it
 * would block instead of failing. A configured credential helper (keychain,
 * manager, GUI askpass) still works — only the invisible prompt is refused.
 */
const pushGitRunner: GitRunner = async (args, cwd) => {
  const { stdout, stderr } = await execFileAsync('git', args, {
    cwd,
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
    timeout: PUSH_TIMEOUT_MS,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
  })
  return { stdout, stderr }
}

/** The `gh` seam — same shape as worktree.ts' git runner, injectable for tests. */
export type GhRunner = (args: string[], cwd: string) => Promise<GitResult>

/** Marker a runner throws (or `code: 'ENOENT'`) when the GitHub CLI is absent. */
export const GH_MISSING_CODE = 'ENOENT'

export const defaultGhRunner: GhRunner = async (args, cwd) => {
  const { stdout, stderr } = await execFileAsync('gh', args, {
    cwd,
    windowsHide: true,
    maxBuffer: 4 * 1024 * 1024,
    timeout: GH_TIMEOUT_MS
  })
  return { stdout, stderr }
}

export interface PullRequestDeps extends WorktreeDeps {
  gh?: GhRunner
}

export interface OpenPullRequestInput {
  repoPath: string
  /** Branch the PR is opened FROM — a `vertragus/*` run branch. */
  head: string
  /** Branch the PR is opened AGAINST. */
  base: string
  remote: string
  title: string
  body: string
  draft?: boolean
}

/**
 * Why no pull request exists. Every reason is a sentence the user can act on;
 * `compareUrl` is filled whenever the branch did reach the remote, so the
 * failure still ends in a working link.
 */
export type PullRequestFailure =
  | 'push_failed'
  | 'gh_missing'
  | 'gh_failed'

export type PullRequestOutcome =
  | { ok: true; url: string; created: boolean }
  | { ok: false; reason: PullRequestFailure; message: string; compareUrl?: string }

/** `main`, or `HEAD` in a detached checkout. */
export async function currentBranch(
  repoPath: string,
  deps: WorktreeDeps = {}
): Promise<string> {
  const git = deps.git ?? defaultGitRunner
  const { stdout } = await git(['rev-parse', '--abbrev-ref', 'HEAD'], repoPath)
  return stdout.trim()
}

/**
 * How many commits `head` has that `base` does not. `undefined` when git
 * cannot answer (unknown ref, no merge base) — a caller must not read that as
 * "nothing to open a PR for", because it is not the same fact.
 */
export async function commitsAhead(
  repoPath: string,
  base: string,
  head: string,
  deps: WorktreeDeps = {}
): Promise<number | undefined> {
  const git = deps.git ?? defaultGitRunner
  try {
    const { stdout } = await git(['rev-list', '--count', `${base}..${head}`], repoPath)
    const count = Number.parseInt(stdout.trim(), 10)
    return Number.isFinite(count) ? count : undefined
  } catch {
    return undefined
  }
}

/**
 * `https://github.com/<owner>/<repo>/compare/<base>...<head>?expand=1` for a
 * GitHub remote, in both the SSH and the HTTPS spelling. Undefined for
 * anything that is not github.com — a compare link only helps where it opens
 * the right form, and inventing one for a self-hosted forge would not.
 */
export function githubCompareUrl(
  remoteUrl: string,
  base: string,
  head: string
): string | undefined {
  const trimmed = remoteUrl.trim().replace(/\.git$/, '')
  const ssh = /^(?:ssh:\/\/)?git@github\.com[:/](?<slug>[^/]+\/[^/]+)$/.exec(trimmed)
  const https = /^https?:\/\/(?:[^@/]+@)?github\.com\/(?<slug>[^/]+\/[^/]+)$/.exec(trimmed)
  const slug = ssh?.groups?.slug ?? https?.groups?.slug
  if (!slug) return undefined
  return `https://github.com/${slug}/compare/${encodeURIComponent(base)}...${encodeURIComponent(
    head
  )}?expand=1`
}

async function compareUrlFor(
  input: OpenPullRequestInput,
  deps: PullRequestDeps
): Promise<string | undefined> {
  const git = deps.git ?? defaultGitRunner
  try {
    const { stdout } = await git(['remote', 'get-url', input.remote], input.repoPath)
    return githubCompareUrl(stdout, input.base, input.head)
  } catch {
    return undefined
  }
}

/** True for the "the CLI is not installed" shape of a spawn failure. */
function isMissingBinary(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code
  return code === GH_MISSING_CODE || /\bENOENT\b/.test(String(error))
}

/** The URL `gh` prints on success (or on "a pull request already exists"). */
function firstPullRequestUrl(text: string): string | undefined {
  return /https:\/\/\S*\/pull\/\d+/.exec(text)?.[0]
}

/**
 * Push `head` to `remote` and open the pull request.
 *
 * `-u` on purpose: the run branch gets its upstream, so a follow-up run (or
 * the user) pushes to the same place without re-typing it. No `--force` under
 * any circumstance — a rejected push means someone else moved that branch, and
 * the honest answer to that is the error, not an overwrite.
 */
export async function openPullRequest(
  input: OpenPullRequestInput,
  deps: PullRequestDeps = {}
): Promise<PullRequestOutcome> {
  // The push runs on the prompt-free, deadlined runner; the local reads
  // (`remote get-url`) go through the ordinary one inside compareUrlFor.
  const push = deps.git ?? pushGitRunner
  const gh = deps.gh ?? defaultGhRunner

  try {
    await push(['push', '-u', input.remote, input.head], input.repoPath)
  } catch (error) {
    return { ok: false, reason: 'push_failed', message: gitErrorMessage(error) }
  }

  const compareUrl = await compareUrlFor(input, deps)
  const args = [
    'pr',
    'create',
    '--head',
    input.head,
    '--base',
    input.base,
    '--title',
    input.title,
    '--body',
    input.body,
    ...(input.draft ? ['--draft'] : [])
  ]

  try {
    const { stdout, stderr } = await gh(args, input.repoPath)
    const url = firstPullRequestUrl(stdout) ?? firstPullRequestUrl(stderr)
    if (url) return { ok: true, url, created: true }
    return {
      ok: false,
      reason: 'gh_failed',
      message: `gh pr create printed no pull request URL: ${stdout.trim() || stderr.trim()}`,
      ...(compareUrl ? { compareUrl } : {})
    }
  } catch (error) {
    if (isMissingBinary(error)) {
      return {
        ok: false,
        reason: 'gh_missing',
        message:
          'The GitHub CLI (gh) is not installed or not on PATH. The branch was pushed — open the pull request yourself.',
        ...(compareUrl ? { compareUrl } : {})
      }
    }
    const message = gitErrorMessage(error)
    // `gh` refuses a second PR for the same head. That is not a failure of the
    // run: the pull request the user asked for exists, so answer with its URL.
    if (/already exists/i.test(message)) {
      const existing = firstPullRequestUrl(message)
      if (existing) return { ok: true, url: existing, created: false }
      try {
        const { stdout } = await gh(['pr', 'view', input.head, '--json', 'url', '-q', '.url'], input.repoPath)
        const url = stdout.trim()
        if (url) return { ok: true, url, created: false }
      } catch {
        /* fall through to the reported failure below */
      }
    }
    return {
      ok: false,
      reason: 'gh_failed',
      message,
      ...(compareUrl ? { compareUrl } : {})
    }
  }
}

export interface PullRequestTextInput {
  workspaceName: string
  goal?: string
  summary?: string
  /** Agent branches that went into this run, newest last. */
  branches?: readonly string[]
}

/** Title of an auto-opened PR: the goal's first line, or the workspace name. */
export function pullRequestTitle(input: PullRequestTextInput): string {
  const line = (input.goal ?? '').split('\n')[0]?.trim()
  const title = line && line.length > 0 ? line : `Vertragus run ${input.workspaceName}`
  return title.length > 120 ? `${title.slice(0, 117)}…` : title
}

/**
 * Body of an auto-opened PR. Deliberately made of host facts only — the run's
 * goal, the retro summary the orchestrator recorded, and the branches that
 * actually went in. No invented review verdicts: the PR says who did the work,
 * the reviewer decides what it is worth.
 */
export function pullRequestBody(input: PullRequestTextInput): string {
  const lines = [`Opened automatically by Vertragus (workspace ${input.workspaceName}).`, '']
  if (input.goal) lines.push('## Goal', '', input.goal.trim(), '')
  if (input.summary) lines.push('## Run summary', '', input.summary.trim(), '')
  const branches = input.branches?.filter(Boolean) ?? []
  if (branches.length > 0) {
    lines.push('## Agent branches', '', ...branches.map((branch) => `- \`${branch}\``), '')
  }
  return lines.join('\n').trim()
}
