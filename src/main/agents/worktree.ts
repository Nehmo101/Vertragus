/**
 * Git worktrees — the isolation every agent gets.
 *
 * Every agent, the orchestrator included, works in its own worktree at
 * `<repo>/.vertragus/worktrees/<agentId>` on its own branch
 * `vertragus/<workspace>/<agent>`. There is no shared-checkout mode: parallel
 * agents — and parallel workspaces on the same repository — must never trample
 * each other's files. The branches merge like any other git branches, so
 * nothing about isolation strands the work.
 *
 * Two deliberate properties:
 *
 * 1. **No shell.** Every git call goes through `execFile` with an argument
 *    array. A workspace or agent name reaches the branch name, and a name is
 *    data — a shell string would make it executable.
 * 2. **No cleanup behind the user's back.** Vertragus never removes a worktree
 *    on its own and never deletes a branch: the work an agent did is the
 *    user's, and a tool that tidies away unmerged commits is a tool nobody
 *    trusts twice. {@link removeWorktree} exists for the panel's cleanup view,
 *    where the USER removes a stale worktree explicitly — without `--force`,
 *    so git itself refuses when uncommitted changes would be lost, and the
 *    branch survives either way.
 */
import { execFile } from 'node:child_process'
import { appendFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { WORKTREE_SECRET_FILES } from '@main/mcp/attach'

const execFileAsync = promisify(execFile)

/** Vertragus' directory inside the repository — worktrees and nothing else. */
export const VERTRAGUS_DIR = '.vertragus'

/** Worktrees live inside the repo so they travel with it and are easy to find. */
export const WORKTREE_ROOT = join(VERTRAGUS_DIR, 'worktrees')

/** Branch namespace; everything Vertragus creates is recognizable at a glance. */
export const BRANCH_PREFIX = 'vertragus'

/** How many `-2`, `-3`, … suffixes are tried before giving up on a branch name. */
const MAX_BRANCH_ATTEMPTS = 50

export interface GitResult {
  stdout: string
  stderr: string
}

/** The single seam every git call goes through — injectable for error tests. */
export type GitRunner = (args: string[], cwd: string) => Promise<GitResult>

export const defaultGitRunner: GitRunner = async (args, cwd) => {
  const { stdout, stderr } = await execFileAsync('git', args, {
    cwd,
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024
  })
  return { stdout, stderr }
}

export interface WorktreeDeps {
  git?: GitRunner
}

/**
 * Path- and ref-safe slug. Git refuses refs with spaces, `~^:?*[`, `..`, `@{`,
 * a leading/trailing `.` or a trailing `.lock`, so nothing but `[a-z0-9-]`
 * survives here. An empty result would produce `vertragus//x`, hence the
 * fallback.
 */
export function slugifyRef(value: string, fallback = 'x'): string {
  const slug = value
    .normalize('NFKD')
    // Combining marks, escaped so this file stays plain ASCII.
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug || fallback
}

/** `vertragus/<workspace>/<agent>` — the branch an isolated agent works on. */
export function worktreeBranchName(workspaceName: string, agentName: string): string {
  return `${BRANCH_PREFIX}/${slugifyRef(workspaceName, 'workspace')}/${slugifyRef(agentName, 'agent')}`
}

/** Absolute path of an agent's worktree inside its repository. */
export function worktreePathFor(repoPath: string, agentId: string): string {
  return join(repoPath, WORKTREE_ROOT, slugifyRef(agentId, 'agent'))
}

export interface WorktreeEntry {
  path: string
  /** Short branch name (`vertragus/paradiso/caronte`), or undefined when detached. */
  branch?: string
  head?: string
  detached: boolean
}

/**
 * Every worktree of a repository, main checkout included. Parsed from
 * `--porcelain` rather than the human format, which pads and truncates.
 */
export async function listWorktrees(
  repoPath: string,
  deps: WorktreeDeps = {}
): Promise<WorktreeEntry[]> {
  const git = deps.git ?? defaultGitRunner
  const { stdout } = await git(['worktree', 'list', '--porcelain'], repoPath)
  const entries: WorktreeEntry[] = []
  let current: WorktreeEntry | undefined

  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line.startsWith('worktree ')) {
      if (current) entries.push(current)
      current = { path: line.slice('worktree '.length), detached: false }
      continue
    }
    if (!current) continue
    if (line.startsWith('HEAD ')) current.head = line.slice('HEAD '.length)
    else if (line.startsWith('branch ')) current.branch = line.slice('branch refs/heads/'.length)
    else if (line === 'detached') current.detached = true
  }
  if (current) entries.push(current)
  return entries
}

/** True when `refs/heads/<branch>` already exists in this repository. */
export async function branchExists(
  repoPath: string,
  branch: string,
  deps: WorktreeDeps = {}
): Promise<boolean> {
  const git = deps.git ?? defaultGitRunner
  try {
    await git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], repoPath)
    return true
  } catch {
    return false
  }
}

/**
 * First free `<branch>`, `<branch>-2`, `<branch>-3`, … .
 *
 * Needed because branches deliberately outlive their worktree: the second run
 * of the same workspace hands the same place-name to the same role, and
 * `git worktree add -b` on an existing branch fails outright.
 */
export async function uniqueBranchName(
  repoPath: string,
  branch: string,
  deps: WorktreeDeps = {}
): Promise<string> {
  for (let attempt = 1; attempt <= MAX_BRANCH_ATTEMPTS; attempt += 1) {
    const candidate = attempt === 1 ? branch : `${branch}-${attempt}`
    if (!(await branchExists(repoPath, candidate, deps))) return candidate
  }
  throw new Error(
    `No free branch name after ${MAX_BRANCH_ATTEMPTS} attempts starting at "${branch}". ` +
      'Delete some old vertragus/* branches.'
  )
}

export interface CreatedWorktree {
  path: string
  branch: string
}

export interface CreateWorktreeOptions extends WorktreeDeps {
  /**
   * Existing ref the agent's branch starts from — another agent's branch, when
   * one agent builds on another's result. Absent = HEAD of the main checkout.
   */
  startPoint?: string
}

function gitErrorMessage(error: unknown): string {
  if (error && typeof error === 'object') {
    const shaped = error as { stderr?: string; message?: string }
    const stderr = shaped.stderr?.trim()
    if (stderr) return stderr
    if (shaped.message) return shaped.message
  }
  return String(error)
}

/**
 * Create an isolated worktree for one agent.
 *
 * `git worktree add <repo>/.vertragus/worktrees/<agentId> -b <branch>
 * [<startPoint>]` — no shell, no interpolation. Failures are rethrown with
 * git's own stderr, because "not a git repository", "already exists" and
 * "invalid reference" (a baseBranch the orchestrator misremembered) need very
 * different reactions and all are invisible in an exit code.
 */
export async function createWorktree(
  repoPath: string,
  agentId: string,
  branchName: string,
  options: CreateWorktreeOptions = {}
): Promise<CreatedWorktree> {
  const git = options.git ?? defaultGitRunner
  const path = worktreePathFor(repoPath, agentId)
  const branch = await uniqueBranchName(repoPath, branchName, options)

  // git creates the leaf itself but not the two levels above it.
  await mkdir(dirname(path), { recursive: true })
  // `.vertragus/` self-ignores (the node_modules pattern): the worktrees sit
  // inside the repository, and without this every checkout in the main working
  // copy shows up untracked — noise in the user's `git status` at best, an
  // accidental `git add -A` of all the worktrees at worst.
  await writeFile(join(repoPath, VERTRAGUS_DIR, '.gitignore'), '*\n', { flag: 'wx' }).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code !== 'EEXIST') throw error
    }
  )
  await ensureSecretExcludes(repoPath)

  try {
    const args = ['worktree', 'add', path, '-b', branch]
    if (options.startPoint) args.push(options.startPoint)
    await git(args, repoPath)
  } catch (error) {
    throw new Error(
      `git worktree add failed for agent ${agentId} in ${repoPath}: ${gitErrorMessage(error)}`
    )
  }
  return { path, branch }
}

/** Identity of the host's snapshot commits — deliberately not the user's. */
export const SNAPSHOT_AUTHOR_NAME = 'Vertragus'
export const SNAPSHOT_AUTHOR_EMAIL = 'vertragus@localhost'

/**
 * C3: commit EVERYTHING in one agent worktree onto its own branch — the
 * host's snapshot at done-time. No push, no `--force`, and `--no-verify` on
 * purpose: repo hooks belong to the user's own commits, not to a host
 * snapshot whose only job is to make `baseBranch` point at the work. The
 * author identity is pinned so the commit works on machines without a global
 * git identity and is recognisable as host-made.
 */
export async function commitWorktree(
  worktreePath: string,
  message: string,
  deps: WorktreeDeps = {}
): Promise<void> {
  const git = deps.git ?? defaultGitRunner
  const identity = [
    '-c',
    `user.name=${SNAPSHOT_AUTHOR_NAME}`,
    '-c',
    `user.email=${SNAPSHOT_AUTHOR_EMAIL}`
  ]
  try {
    await git(['add', '-A'], worktreePath)
    await git([...identity, 'commit', '-m', message, '--no-verify'], worktreePath)
  } catch (error) {
    throw new Error(`git snapshot commit failed in ${worktreePath}: ${gitErrorMessage(error)}`)
  }
}

/** Outcome of one host-side merge (E1) — never a throw for a plain conflict. */
export type MergeOutcome =
  | { ok: true; headSha: string }
  | { ok: false; conflictFiles: string[]; message: string }

/**
 * E1: merge `branch` into the checkout at `worktreePath` — the host-side
 * integrate. No push, no `--force`; identity pinned like the snapshot commits.
 * A conflict ABORTS the merge (the worktree stays clean) and reports the
 * conflicting files instead of leaving a half-merged tree for an agent to
 * stumble into.
 */
export async function mergeBranchIntoWorktree(
  worktreePath: string,
  branch: string,
  deps: WorktreeDeps = {}
): Promise<MergeOutcome> {
  const git = deps.git ?? defaultGitRunner
  const identity = [
    '-c',
    `user.name=${SNAPSHOT_AUTHOR_NAME}`,
    '-c',
    `user.email=${SNAPSHOT_AUTHOR_EMAIL}`
  ]
  try {
    await git([...identity, 'merge', '--no-edit', branch], worktreePath)
  } catch (error) {
    const message = gitErrorMessage(error)
    let conflictFiles: string[] = []
    try {
      const { stdout } = await git(['diff', '--name-only', '--diff-filter=U'], worktreePath)
      conflictFiles = stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .slice(0, 80)
    } catch {
      /* the abort below still runs */
    }
    // Leave a CLEAN worktree behind — a half-merged tree under a working
    // agent is worse than the conflict report.
    await git(['merge', '--abort'], worktreePath).catch(() => undefined)
    return { ok: false, conflictFiles, message }
  }
  const { stdout } = await git(['rev-parse', 'HEAD'], worktreePath)
  return { ok: true, headSha: stdout.trim() }
}

/**
 * Put the MCP config files the attach dialects write into agent worktrees on
 * the repository's `.git/info/exclude`.
 *
 * Linked worktrees share that file, so one entry covers every agent checkout:
 * the files carry the agent's tokenised MCP URL, and an agent running
 * `git add -A` in its own worktree must not be able to commit its token into
 * the user's history. Exclude (not `.gitignore`) on purpose — it never touches
 * the user's own tracked files, and a `.cursor/mcp.json` the user tracks
 * deliberately keeps showing its diff. Skipped when `<repo>/.git` is not a
 * directory (the repo is itself a linked worktree); idempotent otherwise.
 */
async function ensureSecretExcludes(repoPath: string): Promise<void> {
  const gitDir = join(repoPath, '.git')
  try {
    if (!(await stat(gitDir)).isDirectory()) return
  } catch {
    return
  }
  const excludePath = join(gitDir, 'info', 'exclude')
  let current = ''
  try {
    current = await readFile(excludePath, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const present = new Set(current.split('\n').map((line) => line.trim()))
  const missing = WORKTREE_SECRET_FILES.map((file) => `/${file}`).filter(
    (pattern) => !present.has(pattern)
  )
  if (missing.length === 0) return
  await mkdir(dirname(excludePath), { recursive: true })
  const separator = current === '' || current.endsWith('\n') ? '' : '\n'
  await appendFile(
    excludePath,
    `${separator}# Vertragus: agent MCP config files carry per-agent tokens - never commit them.\n${missing.join('\n')}\n`
  )
}

/**
 * Remove one worktree — the panel's cleanup view, on the user's explicit click.
 *
 * Deliberately WITHOUT `--force`: a worktree with uncommitted changes makes git
 * refuse, and that refusal (with git's own wording) travels to the panel
 * instead of the changes travelling to /dev/null. The branch is never touched —
 * committed work stays reachable after the checkout is gone.
 */
export async function removeWorktree(
  repoPath: string,
  worktreePath: string,
  deps: WorktreeDeps = {}
): Promise<void> {
  const git = deps.git ?? defaultGitRunner
  try {
    await git(['worktree', 'remove', worktreePath], repoPath)
  } catch (error) {
    throw new Error(
      `git worktree remove failed for ${worktreePath}: ${gitErrorMessage(error)}`
    )
  }
}
