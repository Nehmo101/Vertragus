import { exec, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { TaskGateFinding } from '@shared/orchestrator'

export const execFileAsync = promisify(execFile)
export const execAsync = promisify(exec)
export const MAX_OUTPUT = 8 * 1024 * 1024

/**
 * Worker scratch files that must never reach a commit. Retros show workers
 * leaving *.origcheck/*.check/.verify-*-tmp.md droppings despite prompt-level
 * prohibitions — enforcement has to live in the commit path.
 */
const SCRATCH_FILE_PATTERNS = [
  /\.(?:origcheck|c9check|check|orig|rej|bak|tmp)$/i,
  /(?:^|\/)\.verify-[^/]+$/i,
  /~$/
]

export function scratchFiles(files: readonly string[]): string[] {
  return files.filter((file) => SCRATCH_FILE_PATTERNS.some((pattern) => pattern.test(file)))
}

/** Trailing whitespace/CRLF is fixable follow-up work, never a hard blocker. */
export class CommitHygieneError extends Error {
  readonly code = 'commit-hygiene'
  constructor(readonly check: string, detail: string) {
    super(`Commit-Hygiene fehlgeschlagen (${check}): ${detail}`)
    this.name = 'CommitHygieneError'
  }
}

export async function runFile(cwd: string, command: string, args: string[]): Promise<string> {
  const { stdout, stderr } = await execFileAsync(command, args, {
    cwd,
    windowsHide: true,
    timeout: 120_000,
    maxBuffer: MAX_OUTPUT
  })
  return (stdout || stderr || '').trim()
}

export async function git(cwd: string, args: string[]): Promise<string> {
  return runFile(cwd, 'git', args)
}

/**
 * `git merge-base --is-ancestor a b` exits 0 when `a` is an ancestor of `b`,
 * 1 when it is not, and >1 on a real error. The plain `git()` helper throws on
 * any non-zero exit, so the ancestor question needs an exit-code-aware runner.
 */
export async function isAncestor(cwd: string, ancestor: string, descendant: string): Promise<boolean> {
  try {
    await execFileAsync('git', ['merge-base', '--is-ancestor', ancestor, descendant], {
      cwd,
      windowsHide: true,
      timeout: 120_000,
      maxBuffer: MAX_OUTPUT
    })
    return true
  } catch (error) {
    const code = (error as { code?: number | string }).code
    if (code === 1) return false
    throw error
  }
}

/** git diff --cached --check als klassifizierbarer Hygiene-Fehler statt plain Error. */
export async function assertStagedHygiene(worktree: string): Promise<void> {
  try {
    await git(worktree, ['diff', '--cached', '--check'])
  } catch (error) {
    throw new CommitHygieneError(
      'git diff --cached --check',
      error instanceof Error ? error.message : String(error)
    )
  }
}

export async function stagedFileList(worktree: string): Promise<string[]> {
  return (await git(worktree, ['diff', '--cached', '--name-only']))
    .split(/\r?\n/)
    .map((file) => file.trim())
    .filter(Boolean)
}

/** Entfernt Scratch-Dateien aus dem Staging (nicht aus dem Worktree) und meldet sie. */
export async function unstageScratchFiles(worktree: string): Promise<TaskGateFinding[]> {
  const scratch = scratchFiles(await stagedFileList(worktree))
  if (scratch.length === 0) return []
  await git(worktree, ['reset', '-q', 'HEAD', '--', ...scratch])
  return [{
    gate: 'commit',
    code: 'temp-files-removed',
    message: `${scratch.length} Scratch-Datei(en) wurden vor dem Commit aus dem Staging entfernt.`,
    files: scratch
  }]
}

export function safeSlug(value: string, max = 42): string {
  return (
    value
      .normalize('NFKD')
      .replace(/[^a-zA-Z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .toLowerCase()
      .slice(0, max) || 'vertragus-task'
  )
}

export async function repositoryRoot(cwd: string): Promise<string> {
  const porcelain = await git(cwd, ['worktree', 'list', '--porcelain'])
  const first = porcelain.match(/^worktree\s+(.+)$/m)?.[1]
  if (!first) throw new Error('Repository-Hauptworktree konnte nicht bestimmt werden.')
  return first.trim()
}
