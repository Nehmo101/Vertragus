import { posix, win32 } from 'node:path'
import { stripAnsi } from '@main/agents/limitSignals'

const ORCA_WORKTREE_DIR = '.orca-worktrees'
const ORCA_WORKTREE_PART = /^[a-z0-9._-]+$/i

export type CursorWorkspaceTrustPrompt = 'ready' | 'partial' | 'none'

function usesWindowsPath(value: string): boolean {
  return /^[a-z]:[\\/]/i.test(value) || value.startsWith('\\\\')
}

/** Return a portable canonical form for an absolute workspace path. */
export function normalizeWorkspacePath(value: string): string | undefined {
  const visible = stripAnsi(value).trim()
  const path = usesWindowsPath(visible) ? win32 : posix
  if (!path.isAbsolute(visible)) return undefined

  const normalized = path.normalize(visible).replace(/[\\/]+$/, '')
  if (!normalized) return undefined
  return usesWindowsPath(visible)
    ? normalized.replace(/\\/g, '/').toLowerCase()
    : normalized
}

/**
 * Orca creates only <repo>/.orca-worktrees/<session>/<agent> directories.
 * The `worktree` field itself is set exclusively by createWorktree; this
 * structural check makes that ownership boundary explicit before typing into a
 * provider terminal.
 */
export function isOrcaWorktreePath(value: string): boolean {
  const normalized = normalizeWorkspacePath(value)
  if (!normalized) return false
  const parts = normalized.split('/').filter(Boolean)
  const [marker, session, agent] = parts.slice(-3)
  return (
    marker === ORCA_WORKTREE_DIR &&
    ORCA_WORKTREE_PART.test(session ?? '') &&
    ORCA_WORKTREE_PART.test(agent ?? '')
  )
}

function visibleTerminalText(output: string): string {
  return stripAnsi(output)
    .replace(/\r\n?/g, '\n')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
    .replace(/[ \t]+/g, ' ')
}

function outputMentionsWorkspace(output: string, workspace: string): boolean {
  const normalizedWorkspace = normalizeWorkspacePath(workspace)
  if (!normalizedWorkspace) return false
  const terminal = visibleTerminalText(output)
  const normalizedTerminal = usesWindowsPath(workspace)
    ? terminal.replace(/\\/g, '/').toLowerCase()
    : terminal
  return normalizedTerminal.includes(normalizedWorkspace)
}

const TRUST_THIS_WORKSPACE_RE = /\btrust\s+(?:this\s+)?workspace\b/i
const TRUST_WITH_A_RE =
  /(?:\[\s*a\s*\]|\(\s*a\s*\)|\ba\s*[.)\-:])\s*(?:trust\s+(?:this\s+)?workspace)\b|\btrust\s+(?:this\s+)?workspace\b\s*(?:\[\s*a\s*\]|\(\s*a\s*\)|\ba\s*[.)\-:])|\b(?:press|type)\s+(?:the\s+)?(?:key\s+)?["'`[]?a["'`\]]?\s+to\s+trust\s+(?:this\s+)?workspace\b/i

function hasOrcaWorktreeOwnership(input: {
  workingDir: string
  worktree?: string
  alreadyHandled: boolean
  interactiveUsed: boolean
}): boolean {
  if (input.alreadyHandled || input.interactiveUsed || !input.worktree) return false
  const workingDir = normalizeWorkspacePath(input.workingDir)
  const worktree = normalizeWorkspacePath(input.worktree)
  return Boolean(worktree && workingDir && worktree === workingDir && isOrcaWorktreePath(input.worktree))
}

/**
 * Classify Cursor's interactive trust screen. `partial` is deliberately
 * limited to Orca-owned worktrees so retrying terminal output never affects a
 * user-selected workspace.
 */
export function cursorWorkspaceTrustPrompt(input: {
  output: string
  workingDir: string
  worktree?: string
  alreadyHandled: boolean
  interactiveUsed: boolean
}): CursorWorkspaceTrustPrompt {
  if (!hasOrcaWorktreeOwnership(input)) return 'none'

  const text = visibleTerminalText(input.output)
  if (!TRUST_THIS_WORKSPACE_RE.test(text)) return 'none'
  if (!outputMentionsWorkspace(text, input.workingDir) || !TRUST_WITH_A_RE.test(text)) return 'partial'
  return 'ready'
}

/**
 * Cursor Agent's interactive TUI does not accept its `--trust` switch (that
 * option is restricted to `--print`). Detect its initial trust screen so Orca
 * can confirm only the disposable worktrees it created itself.
 */
export function shouldAutoTrustCursorWorktree(input: {
  output: string
  workingDir: string
  worktree?: string
  alreadyHandled: boolean
  interactiveUsed: boolean
}): boolean {
  return cursorWorkspaceTrustPrompt(input) === 'ready'
}
