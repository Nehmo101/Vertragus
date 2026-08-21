/**
 * Read-only git inspection of one agent's worktree.
 *
 * The orchestrator must not run git itself, and its own checkout is the
 * repository HEAD — not Caronte's files. This is the host-truth path: status,
 * diff, log and file reads against the agent's worktree, never the main
 * checkout. No writes, no `git add`, no shell.
 *
 * The thrown messages here are RAW ENGLISH ON PURPOSE and must not be moved
 * into `mainMessages`. They travel back as MCP tool-call errors, so their only
 * reader is the orchestrator LLM — which has to act on them ("narrow the path",
 * "that file is binary"). Translating them would put the instruction in a
 * language the tool contract is not written in, for no human's benefit.
 */
import { readFile } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'
import { defaultGitRunner, type WorktreeDeps } from './worktree'

export const INSPECT_VIEWS = ['status', 'diff', 'log', 'file'] as const
export type InspectView = (typeof INSPECT_VIEWS)[number]

/**
 * A full worktree diff is the single biggest thing the orchestrator can pull
 * into its context — 80 k chars are ~20 k tokens in one tool result and starve
 * the loop it has to keep running. The cap is deliberately small; the way to
 * see more is to narrow (path filter, file view), not to raise it.
 */
export const INSPECT_DIFF_MAX_CHARS = 20_000
export const INSPECT_FILE_MAX_CHARS = 80_000
export const INSPECT_LOG_DEFAULT_LINES = 20
export const INSPECT_LOG_MAX_LINES = 50
export const INSPECT_CHANGED_FILES_MAX = 80
export const INSPECT_DIFFSTAT_MAX = 800

export interface WorktreeSnapshot {
  branch: string
  headSha: string
  porcelain: string
  uncommitted: boolean
  changedFiles: string[]
  diffStat: string
}

export interface InspectWorktreeInput {
  worktreePath: string
  view: InspectView
  /**
   * Relative path inside the worktree — required for `file`, optional for
   * `diff` (file or directory pathspec that scopes it), ignored otherwise.
   */
  path?: string
  /** Line count for `log`; ignored otherwise. */
  lines?: number
}

export interface InspectWorktreeResult extends WorktreeSnapshot {
  view: InspectView
  body: string
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
 * Truncation is a dead end unless the model is told the way out — without a
 * hint it either re-requests the same oversized view or guesses. The marker
 * therefore names the cap and the narrower call that would have fit.
 */
function cap(text: string, max: number, hint?: string): string {
  if (text.length <= max) return text
  const how = hint ? ` — ${hint}` : ''
  return `${text.slice(0, max)}\n…(truncated at ${max} chars${how})`
}

const DIFF_TRUNCATION_HINT =
  'narrow it instead of asking again: pass path ("src/foo" or "src/foo/bar.ts") to diff only that file or directory, use view "file" to read a single file in full, or judge from view "status" (porcelain + diffStat).'

const FILE_TRUNCATION_HINT =
  'this file is longer than the cap — use view "diff" with path to see only what changed in it.'

/** Normalize a caller path for git pathspecs and porcelain prefix matching. */
function normalizeRelPath(requested: string): string {
  return requested.trim().replace(/\\/g, '/').replace(/\/+$/, '')
}

/** Porcelain `XY PATH` / `XY old -> new` → the resulting path. */
export function parsePorcelainPaths(porcelain: string): string[] {
  const files: string[] = []
  for (const raw of porcelain.split(/\r?\n/)) {
    const line = raw.trimEnd()
    if (line.length < 4) continue
    const rest = line.slice(3)
    const arrow = rest.indexOf(' -> ')
    const path = (arrow >= 0 ? rest.slice(arrow + 4) : rest).trim()
    if (path) files.push(path)
  }
  return files.slice(0, INSPECT_CHANGED_FILES_MAX)
}

/**
 * Resolve a caller-supplied path against a worktree. Absolute paths, `..`
 * segments and anything that would land outside the worktree are refused —
 * this is a read of *that* agent's files, not of the host machine.
 */
export function resolveInsideWorktree(worktreePath: string, requested: string): string {
  const trimmed = requested.trim()
  if (!trimmed || trimmed.includes('\0')) {
    throw new Error('inspect path is empty or invalid.')
  }
  if (isAbsolute(trimmed) || /^[a-zA-Z]:[\\/]/.test(trimmed)) {
    throw new Error('inspect path must be relative to the agent worktree.')
  }
  const parts = trimmed.replace(/\\/g, '/').split('/')
  if (parts.some((part) => part === '..')) {
    throw new Error('inspect path must not contain "..".')
  }
  const root = resolve(worktreePath)
  const candidate = resolve(root, trimmed)
  const rel = relative(root, candidate)
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error('inspect path escapes the agent worktree.')
  }
  return candidate
}

async function gitText(
  args: string[],
  cwd: string,
  deps: WorktreeDeps
): Promise<string> {
  const git = deps.git ?? defaultGitRunner
  try {
    const { stdout } = await git(args, cwd)
    return stdout
  } catch (error) {
    throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${gitErrorMessage(error)}`)
  }
}

/** Snapshot of one worktree: branch, HEAD, porcelain, diffstat. */
export async function snapshotWorktree(
  worktreePath: string,
  deps: WorktreeDeps = {}
): Promise<WorktreeSnapshot> {
  const [branchRaw, headRaw, porcelain, diffStat] = await Promise.all([
    gitText(['rev-parse', '--abbrev-ref', 'HEAD'], worktreePath, deps),
    gitText(['rev-parse', 'HEAD'], worktreePath, deps),
    // `-uall` so a new directory lists its files, not just `src/`.
    gitText(['status', '--porcelain', '--untracked-files=all'], worktreePath, deps),
    gitText(['diff', '--stat', 'HEAD'], worktreePath, deps)
  ])
  const porcelainTrimmed = porcelain.replace(/\s+$/, '')
  const changedFiles = parsePorcelainPaths(porcelainTrimmed)
  return {
    branch: branchRaw.trim(),
    headSha: headRaw.trim(),
    porcelain: porcelainTrimmed,
    uncommitted: porcelainTrimmed.length > 0,
    changedFiles,
    diffStat: cap(diffStat.trim(), INSPECT_DIFFSTAT_MAX)
  }
}

export async function inspectWorktree(
  input: InspectWorktreeInput,
  deps: WorktreeDeps = {}
): Promise<InspectWorktreeResult> {
  const snapshot = await snapshotWorktree(input.worktreePath, deps)

  if (input.view === 'status') {
    const body = [
      `branch ${snapshot.branch}`,
      `HEAD ${snapshot.headSha}`,
      snapshot.uncommitted ? 'uncommitted: yes' : 'uncommitted: no',
      snapshot.diffStat ? snapshot.diffStat : '(no diffstat)',
      snapshot.porcelain || '(clean)'
    ].join('\n')
    return { ...snapshot, view: 'status', body }
  }

  if (input.view === 'diff') {
    // `path` is optional here: the escape hatch out of a capped full diff is a
    // scoped one, so the same traversal rules as `file` apply (a pathspec that
    // escapes the worktree would diff the host).
    const scope = input.path ? normalizeRelPath(input.path) : ''
    if (scope) resolveInsideWorktree(input.worktreePath, scope)
    const args = scope ? ['diff', 'HEAD', '--', scope] : ['diff', 'HEAD']
    const diff = cap(
      (await gitText(args, input.worktreePath, deps)).trimEnd(),
      INSPECT_DIFF_MAX_CHARS,
      DIFF_TRUNCATION_HINT
    )
    const untracked = snapshot.porcelain
      .split(/\r?\n/)
      .filter((line) => line.startsWith('??'))
      .map((line) => line.slice(3).trim())
      .filter(Boolean)
      .filter((path) => !scope || path === scope || path.startsWith(`${scope}/`))
    const header =
      untracked.length > 0
        ? `untracked:\n${untracked.map((path) => `  ${path}`).join('\n')}\n`
        : ''
    const empty = scope ? `(no tracked diff under ${scope})` : '(no tracked diff)'
    return { ...snapshot, view: 'diff', body: `${header}${diff || empty}` }
  }

  if (input.view === 'log') {
    const count = Math.min(
      Math.max(1, input.lines ?? INSPECT_LOG_DEFAULT_LINES),
      INSPECT_LOG_MAX_LINES
    )
    const body = (
      await gitText(['log', '-n', String(count), '--oneline'], input.worktreePath, deps)
    ).trimEnd()
    return { ...snapshot, view: 'log', body: body || '(no commits)' }
  }

  const rel = input.path?.trim()
  if (!rel) throw new Error('inspect view "file" needs path.')
  const abs = resolveInsideWorktree(input.worktreePath, rel)
  let text: string
  try {
    text = await readFile(abs, 'utf8')
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') throw new Error(`file not found in the worktree: ${rel}`)
    throw error
  }
  if (text.includes('\0')) throw new Error(`file looks binary, not shown: ${rel}`)
  return {
    ...snapshot,
    view: 'file',
    body: cap(text, INSPECT_FILE_MAX_CHARS, FILE_TRUNCATION_HINT)
  }
}
