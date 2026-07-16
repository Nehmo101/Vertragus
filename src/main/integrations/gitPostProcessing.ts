import { execFile } from 'node:child_process'
import { isAbsolute, resolve } from 'node:path'
import { promisify } from 'node:util'
import { isValidPostProcessBranch } from '@shared/gitPostProcessing'

export { isValidPostProcessBranch } from '@shared/gitPostProcessing'

const execFileAsync = promisify(execFile)
const DEFAULT_REMOTE = 'origin'
const MAX_COMMIT_MESSAGE_LENGTH = 500
const MAX_ERROR_DETAIL_LENGTH = 4_000

export type GitPostProcessPhase =
  | 'validation'
  | 'repository'
  | 'status'
  | 'precondition'
  | 'stage'
  | 'commit'
  | 'push'

export type GitPostProcessErrorCode =
  | 'INVALID_WORKSPACE'
  | 'WORKSPACE_NOT_ROOT'
  | 'INVALID_TARGET_BRANCH'
  | 'INVALID_COMMIT_MESSAGE'
  | 'NOT_REPOSITORY'
  | 'STATUS_FAILED'
  | 'DETACHED_HEAD'
  | 'REMOTE_MISSING'
  | 'STAGE_FAILED'
  | 'NO_STAGED_CHANGES'
  | 'COMMIT_FAILED'
  | 'PUSH_REJECTED'

export type GitPostProcessMutation = 'none' | 'staged' | 'committed' | 'unknown'

export interface GitPostProcessInput {
  /** Absolute path to the exact root of the worktree to process. */
  workspaceDir: string
  /** Explicit remote branch name; never inferred from an upstream. */
  targetBranch: string
  /** Single-line commit subject. It is passed as one execFile argument. */
  commitMessage: string
}

interface GitPostProcessBase {
  ok: boolean
  workspaceDir: string
  targetBranch: string
  remote: typeof DEFAULT_REMOTE
  changedFiles: string[]
  sourceBranch?: string
  commit?: string
}

export interface GitPostProcessCleanResult extends GitPostProcessBase {
  ok: true
  status: 'clean'
  changedFiles: []
}

export interface GitPostProcessPushedResult extends GitPostProcessBase {
  ok: true
  status: 'pushed'
  sourceBranch: string
  commit: string
}

export interface GitPostProcessFailure extends GitPostProcessBase {
  ok: false
  status: 'failed'
  error: {
    code: GitPostProcessErrorCode
    phase: GitPostProcessPhase
    message: string
    detail?: string
    retryable: boolean
    mutation: GitPostProcessMutation
  }
}

export type GitPostProcessResult =
  | GitPostProcessCleanResult
  | GitPostProcessPushedResult
  | GitPostProcessFailure

export interface GitCommandResult {
  stdout: string
  stderr: string
}

export interface GitPostProcessorDependencies {
  /** Test seam. Production callers should use the default exported service. */
  runGit?: (cwd: string, args: readonly string[]) => Promise<GitCommandResult>
}

type WorkspaceQueue = Map<string, Promise<void>>

async function defaultRunGit(cwd: string, args: readonly string[]): Promise<GitCommandResult> {
  const { stdout, stderr } = await execFileAsync('git', [...args], {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    timeout: args[0] === 'push' ? 120_000 : 30_000,
    maxBuffer: 8 * 1024 * 1024
  })
  return { stdout: String(stdout), stderr: String(stderr) }
}

function workspaceKey(path: string): string {
  const normalized = resolve(path).replace(/\\/g, '/')
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

async function inWorkspaceQueue<T>(queue: WorkspaceQueue, key: string, action: () => Promise<T>): Promise<T> {
  const previous = queue.get(key) ?? Promise.resolve()
  let release!: () => void
  const current = new Promise<void>((resolveCurrent) => {
    release = resolveCurrent
  })
  const tail = previous.then(() => current, () => current)
  queue.set(key, tail)

  await previous.catch(() => undefined)
  try {
    return await action()
  } finally {
    release()
    if (queue.get(key) === tail) queue.delete(key)
  }
}

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0)
    return code <= 31 || code === 127
  })
}

function isValidCommitMessage(message: string): boolean {
  if (!message) return false
  return Boolean(
    message === message.trim() &&
    message.length <= MAX_COMMIT_MESSAGE_LENGTH &&
    !hasControlCharacter(message)
  )
}

function redactGitDetail(value: string): string {
  return value
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@/gi, '$1[redacted]@')
    .trim()
    .slice(0, MAX_ERROR_DETAIL_LENGTH)
}

function gitErrorDetail(error: unknown): string | undefined {
  if (error && typeof error === 'object') {
    const failed = error as { stderr?: unknown; stdout?: unknown; message?: unknown }
    const detail = [failed.stderr, failed.stdout, failed.message]
      .find((value) => typeof value === 'string' && value.trim())
    if (typeof detail === 'string') return redactGitDetail(detail)
  }
  if (error instanceof Error) return redactGitDetail(error.message)
  const detail = redactGitDetail(String(error))
  return detail || undefined
}

function nulSeparatedPaths(output: string): string[] {
  return [...new Set(output.split('\0').filter(Boolean))].sort()
}

function statusPaths(output: string): string[] {
  const records = output.split('\0')
  const paths: string[] = []
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]
    if (!record || record.length < 4) continue
    paths.push(record.slice(3))
    if (/R|C/.test(record.slice(0, 2)) && records[index + 1]) {
      paths.push(records[index + 1]!)
      index += 1
    }
  }
  return [...new Set(paths)].sort()
}

function failure(
  input: GitPostProcessInput,
  workspaceDir: string,
  changedFiles: string[],
  code: GitPostProcessErrorCode,
  phase: GitPostProcessPhase,
  message: string,
  options: {
    detail?: string
    retryable?: boolean
    mutation?: GitPostProcessMutation
    sourceBranch?: string
    commit?: string
  } = {}
): GitPostProcessFailure {
  return {
    ok: false,
    status: 'failed',
    workspaceDir,
    targetBranch: input.targetBranch,
    remote: DEFAULT_REMOTE,
    changedFiles,
    sourceBranch: options.sourceBranch,
    commit: options.commit,
    error: {
      code,
      phase,
      message,
      detail: options.detail,
      retryable: options.retryable ?? false,
      mutation: options.mutation ?? 'none'
    }
  }
}

async function processWorkspace(
  input: GitPostProcessInput,
  workspaceDir: string,
  runGit: NonNullable<GitPostProcessorDependencies['runGit']>
): Promise<GitPostProcessResult> {
  let repositoryRoot: string
  try {
    repositoryRoot = (await runGit(workspaceDir, ['rev-parse', '--show-toplevel'])).stdout.trim()
  } catch (error) {
    return failure(
      input,
      workspaceDir,
      [],
      'NOT_REPOSITORY',
      'repository',
      'Das Workspace-Verzeichnis ist kein verwendbares Git-Repository.',
      { detail: gitErrorDetail(error) }
    )
  }

  if (!repositoryRoot || workspaceKey(repositoryRoot) !== workspaceKey(workspaceDir)) {
    return failure(
      input,
      workspaceDir,
      [],
      'WORKSPACE_NOT_ROOT',
      'repository',
      'Post-Processing ist nur am exakten Root des übergebenen Worktrees erlaubt.'
    )
  }

  try {
    await runGit(workspaceDir, ['check-ref-format', '--branch', input.targetBranch])
  } catch (error) {
    return failure(
      input,
      workspaceDir,
      [],
      'INVALID_TARGET_BRANCH',
      'validation',
      'Der Ziel-Branch ist kein gültiger Git-Branch.',
      { detail: gitErrorDetail(error) }
    )
  }

  let status: string
  try {
    status = (await runGit(workspaceDir, [
      'status',
      '--porcelain=v1',
      '-z',
      '--untracked-files=all',
      '--',
      '.'
    ])).stdout
  } catch (error) {
    return failure(input, workspaceDir, [], 'STATUS_FAILED', 'status', 'Git-Status konnte nicht gelesen werden.', {
      detail: gitErrorDetail(error),
      retryable: true,
      mutation: 'unknown'
    })
  }

  if (!status) {
    return {
      ok: true,
      status: 'clean',
      workspaceDir,
      targetBranch: input.targetBranch,
      remote: DEFAULT_REMOTE,
      changedFiles: []
    }
  }

  let sourceBranch: string
  const detectedFiles = statusPaths(status)
  try {
    sourceBranch = (await runGit(workspaceDir, ['symbolic-ref', '--quiet', '--short', 'HEAD'])).stdout.trim()
    if (!sourceBranch) throw new Error('HEAD ist nicht an einen Branch gebunden.')
  } catch (error) {
    return failure(
      input,
      workspaceDir,
      detectedFiles,
      'DETACHED_HEAD',
      'precondition',
      'Detached HEAD: Änderungen wurden weder gestaged noch committet.',
      { detail: gitErrorDetail(error) }
    )
  }

  try {
    await runGit(workspaceDir, ['remote', 'get-url', '--push', DEFAULT_REMOTE])
  } catch (error) {
    return failure(
      input,
      workspaceDir,
      detectedFiles,
      'REMOTE_MISSING',
      'precondition',
      `Das Git-Remote ${DEFAULT_REMOTE} ist nicht für Pushes konfiguriert.`,
      { detail: gitErrorDetail(error), sourceBranch }
    )
  }

  try {
    await runGit(workspaceDir, ['add', '--all', '--', '.'])
  } catch (error) {
    return failure(input, workspaceDir, detectedFiles, 'STAGE_FAILED', 'stage', 'Änderungen konnten nicht gestaged werden.', {
      detail: gitErrorDetail(error),
      retryable: true,
      mutation: 'unknown',
      sourceBranch
    })
  }

  let changedFiles: string[]
  try {
    changedFiles = nulSeparatedPaths((await runGit(workspaceDir, [
      'diff',
      '--cached',
      '--name-only',
      '-z',
      '--',
      '.'
    ])).stdout)
  } catch (error) {
    return failure(input, workspaceDir, detectedFiles, 'STAGE_FAILED', 'stage', 'Gestagte Dateien konnten nicht gelesen werden.', {
      detail: gitErrorDetail(error),
      retryable: true,
      mutation: 'staged',
      sourceBranch
    })
  }

  if (changedFiles.length === 0) {
    return failure(
      input,
      workspaceDir,
      detectedFiles,
      'NO_STAGED_CHANGES',
      'stage',
      'Der Workspace ist verändert, enthält aber keine committbaren Änderungen.',
      { mutation: 'staged', sourceBranch }
    )
  }

  try {
    await runGit(workspaceDir, ['commit', '-m', input.commitMessage, '--'])
  } catch (error) {
    return failure(input, workspaceDir, changedFiles, 'COMMIT_FAILED', 'commit', 'Git-Commit ist fehlgeschlagen.', {
      detail: gitErrorDetail(error),
      mutation: 'staged',
      sourceBranch
    })
  }

  let commit: string
  try {
    commit = (await runGit(workspaceDir, ['rev-parse', '--verify', 'HEAD^{commit}'])).stdout.trim()
    if (!commit) throw new Error('Der neue Commit konnte nicht aufgelöst werden.')
  } catch (error) {
    return failure(input, workspaceDir, changedFiles, 'COMMIT_FAILED', 'commit', 'Der erstellte Commit konnte nicht verifiziert werden.', {
      detail: gitErrorDetail(error),
      mutation: 'committed',
      sourceBranch
    })
  }

  try {
    await runGit(workspaceDir, [
      'push',
      '--porcelain',
      '--',
      DEFAULT_REMOTE,
      `HEAD:refs/heads/${input.targetBranch}`
    ])
  } catch (error) {
    return failure(input, workspaceDir, changedFiles, 'PUSH_REJECTED', 'push', 'Git-Push wurde abgewiesen oder ist fehlgeschlagen.', {
      detail: gitErrorDetail(error),
      mutation: 'committed',
      sourceBranch,
      commit
    })
  }

  return {
    ok: true,
    status: 'pushed',
    workspaceDir,
    targetBranch: input.targetBranch,
    remote: DEFAULT_REMOTE,
    changedFiles,
    sourceBranch,
    commit
  }
}

/**
 * Integration contract for optional post-processing after a successful run:
 *
 * - Call exactly once with the absolute worktree root, an explicit target
 *   branch, and a one-line commit subject. Publishing always targets `origin`
 *   with `HEAD:refs/heads/<targetBranch>`; no upstream is inferred.
 * - A clean worktree returns `status: 'clean'` without requiring a branch or
 *   remote and without mutating Git state.
 * - A dirty worktree must have an attached HEAD and push-capable `origin`.
 *   All tracked changes, deletions, and non-ignored untracked files beneath the
 *   exact worktree root are staged, committed, and pushed.
 * - Expected Git and validation failures are returned as `status: 'failed'`.
 *   `error.phase`, `error.code`, `error.mutation`, `changedFiles`, and optional
 *   `commit` tell UI/logging code whether work is untouched, staged, or locally
 *   committed but not pushed. `retryable` means that this complete service call
 *   may safely be repeated. A push failure is not marked retryable because the
 *   worktree is then clean; use its returned `commit` for explicit recovery.
 *   Details redact credentials embedded in URLs.
 * - Calls for the same normalized workspace are FIFO-serialized per service
 *   instance. This prevents concurrent in-process callers from double-committing;
 *   unrelated worktrees remain independent. External Git processes are not locked.
 */
export function createWorkspaceGitPostProcessor(
  dependencies: GitPostProcessorDependencies = {}
): (input: GitPostProcessInput) => Promise<GitPostProcessResult> {
  const runGit = dependencies.runGit ?? defaultRunGit
  const queue: WorkspaceQueue = new Map()

  return async (input: GitPostProcessInput): Promise<GitPostProcessResult> => {
    const suppliedWorkspace = input.workspaceDir ?? ''
    const rawWorkspace = suppliedWorkspace.trim()
    if (
      !rawWorkspace ||
      rawWorkspace !== suppliedWorkspace ||
      !isAbsolute(rawWorkspace) ||
      hasControlCharacter(rawWorkspace)
    ) {
      return failure(
        input,
        rawWorkspace,
        [],
        'INVALID_WORKSPACE',
        'validation',
        'workspaceDir muss ein absoluter, nicht leerer Pfad sein.'
      )
    }
    if (!isValidPostProcessBranch(input.targetBranch)) {
      return failure(
        input,
        resolve(rawWorkspace),
        [],
        'INVALID_TARGET_BRANCH',
        'validation',
        'Der Ziel-Branch verletzt die sichere Branch-Namensrichtlinie.'
      )
    }
    if (!isValidCommitMessage(input.commitMessage)) {
      return failure(
        input,
        resolve(rawWorkspace),
        [],
        'INVALID_COMMIT_MESSAGE',
        'validation',
        'commitMessage muss eine nicht leere, einzeilige Commit-Betreffzeile sein.'
      )
    }

    const workspaceDir = resolve(rawWorkspace)
    return inWorkspaceQueue(queue, workspaceKey(workspaceDir), () =>
      processWorkspace(input, workspaceDir, runGit)
    )
  }
}

export const postProcessWorkspaceGit = createWorkspaceGitPostProcessor()
