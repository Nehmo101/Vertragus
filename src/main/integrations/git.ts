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

async function localBranches(cwd: string): Promise<string[]> {
  const refs = await optionalGit(cwd, ['for-each-ref', '--format=%(refname:short)', 'refs/heads'])
  return refs ? refs.split(/\r?\n/).filter(Boolean) : []
}

type GitWorktreeInfo = NonNullable<GitInfo['worktrees']>[number]

/** Parse the stable, record-oriented output from `git worktree list --porcelain`. */
export function parseWorktreePorcelain(output: string): GitWorktreeInfo[] {
  const worktrees: GitWorktreeInfo[] = []
  let current: GitWorktreeInfo | undefined

  const flush = (): void => {
    if (current?.path) worktrees.push(current)
    current = undefined
  }

  for (const line of output.split(/\0|\r?\n/)) {
    if (!line) {
      flush()
      continue
    }
    const separator = line.indexOf(' ')
    const key = separator < 0 ? line : line.slice(0, separator)
    const value = separator < 0 ? '' : line.slice(separator + 1)

    if (key === 'worktree') {
      flush()
      current = { path: value, detached: false, bare: false }
      continue
    }
    if (!current) continue

    if (key === 'HEAD') current.head = value
    else if (key === 'branch') current.branch = value.replace(/^refs\/heads\//, '')
    else if (key === 'detached') current.detached = true
    else if (key === 'bare') current.bare = true
    else if (key === 'locked') current.locked = value || 'gesperrt'
    else if (key === 'prunable') current.prunable = value || 'entfernbar'
  }
  flush()
  return worktrees
}

function gitErrorDetail(error: unknown): string {
  if (error && typeof error === 'object' && 'stderr' in error) {
    const stderr = String(error.stderr).trim()
    if (stderr) return stderr.replace(/^fatal:\s*/i, '')
  }
  return error instanceof Error ? error.message : String(error)
}

export async function gitInfo(dir: string): Promise<GitInfo> {
  if (!dir?.trim()) return { isRepo: false }
  const root = await repoRoot(dir)
  if (!root) return { isRepo: false }
  const [branch, branches, head, remote, defaultRef, status, worktreeOutput] = await Promise.all([
    currentBranch(root),
    localBranches(root),
    optionalGit(root, ['rev-parse', 'HEAD']),
    optionalGit(root, ['remote', 'get-url', 'origin']),
    optionalGit(root, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']),
    optionalGit(root, ['status', '--porcelain=v1']),
    optionalGit(root, ['worktree', 'list', '--porcelain', '-z'])
  ])
  return {
    isRepo: true,
    root,
    branch: branch ?? undefined,
    branches,
    head,
    remote,
    defaultBranch: defaultRef?.replace(/^origin\//, ''),
    dirty: Boolean(status),
    worktrees: worktreeOutput ? parseWorktreePorcelain(worktreeOutput) : []
  }
}

export async function switchBranch(dir: string, branch: string): Promise<GitInfo> {
  const root = await repoRoot(dir)
  if (!root) throw new Error('Das Arbeitsverzeichnis ist kein Git-Repository.')

  const branches = await localBranches(root)
  if (!branches.includes(branch)) {
    throw new Error(`Lokaler Branch nicht gefunden: ${branch}`)
  }

  try {
    await execFileAsync('git', ['-C', root, 'switch', branch], {
      windowsHide: true,
      timeout: 15000
    })
  } catch (error) {
    throw new Error(`Branch-Wechsel fehlgeschlagen: ${gitErrorDetail(error)}`, { cause: error })
  }

  return gitInfo(root)
}
