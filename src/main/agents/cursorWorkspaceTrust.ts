import { posix, win32 } from 'node:path'
import { stripAnsi } from '@main/agents/limitSignals'

// New checkouts live under `.vertragus-worktrees`; the legacy `.orca-worktrees`
// marker stays trusted so pre-rebrand worktrees keep auto-trust ownership.
const WORKTREE_DIR_MARKERS = ['.vertragus-worktrees', '.orca-worktrees']
const MANAGED_WORKTREE_PART = /^[a-z0-9._-]+$/i
const TRAVERSAL_OR_ALIAS_SEGMENT = /(?:^|[\\/])\.\.?(?:[\\/]|$)/
const WINDOWS_DEVICE_OR_NETWORK_PATH = /^(?:\\\\|\\\\[?.]\\)/

export type CursorWorkspaceTrustPrompt = 'ready' | 'partial' | 'none'

function usesWindowsPath(value: string): boolean {
  return /^[a-z]:[\\/]/i.test(value) || value.startsWith('\\\\')
}

function hasControlCharacter(value: string): boolean {
  for (const char of value) {
    const code = char.charCodeAt(0)
    if (code < 32 || code === 127) return true
  }
  return false
}

/** Return a portable canonical form for verified workspace paths and terminal text. */
export function normalizeWorkspacePath(value: string): string | undefined {
  const visible = stripAnsi(value).trim()
  const path = usesWindowsPath(visible) ? win32 : posix
  if (!path.isAbsolute(visible)) return undefined

  const normalized = path.normalize(visible).replace(/[\\/]+$/, '')
  if (!normalized) return undefined
  return usesWindowsPath(visible) ? normalized.replace(/\\/g, '/').toLowerCase() : normalized
}

/**
 * Accept only the unaliased path shape emitted by worktreeIdentity:
 * <repo>/.vertragus-worktrees/<session>/<agent> (or the legacy
 * <repo>/.orca-worktrees/<session>/<agent>). Do not resolve this value before
 * checking it: resolution could turn a traversal or alias into a trusted path.
 */
export function isExactManagedWorktreePath(value: string): boolean {
  if (
    !value ||
    value !== value.trim() ||
    hasControlCharacter(value) ||
    TRAVERSAL_OR_ALIAS_SEGMENT.test(value) ||
    WINDOWS_DEVICE_OR_NETWORK_PATH.test(value)
  ) {
    return false
  }

  const path = usesWindowsPath(value) ? win32 : posix
  if (!path.isAbsolute(value) || /[\\/]$/.test(value)) return false

  const root = path.parse(value).root
  const parts = value.slice(root.length).split(usesWindowsPath(value) ? /[\\/]/ : '/')
  if (parts.some((part) => !part)) return false

  const [marker, session, agent] = parts.slice(-3)
  return (
    WORKTREE_DIR_MARKERS.includes(marker) &&
    parts.length >= 3 &&
    MANAGED_WORKTREE_PART.test(session ?? '') &&
    MANAGED_WORKTREE_PART.test(agent ?? '')
  )
}

/** Backward-compatible alias for callers that need Vertragus worktree ownership. */
export function isManagedWorktreePath(value: string): boolean {
  return isExactManagedWorktreePath(value)
}

function visibleTerminalText(output: string): string {
  return stripAnsi(output)
    .replace(/\r\n?/g, '\n')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
    .replace(/[ \t]+/g, ' ')
}

// `terminal` must already be flattened via visibleTerminalText — the sole caller
// passes the text it computed once, so this does not re-flatten the buffer.
function outputMentionsWorkspace(terminal: string, workspace: string): boolean {
  const normalizedWorkspace = normalizeWorkspacePath(workspace)
  if (!normalizedWorkspace) return false
  const normalizedTerminal = usesWindowsPath(workspace)
    ? terminal.replace(/\\/g, '/').toLowerCase()
    : terminal
  let start = normalizedTerminal.indexOf(normalizedWorkspace)
  while (start >= 0) {
    const end = start + normalizedWorkspace.length
    const previous = normalizedTerminal[start - 1]
    const next = normalizedTerminal[end]
    const startsAtBoundary =
      start === 0 || /\s/.test(previous) || ['\'', '"', '`', '(', '['].includes(previous)
    const endsAtBoundary =
      end === normalizedTerminal.length || /\s/.test(next) || ['\'', '"', '`', ')', ']', ',', ':', ';'].includes(next)
    if (startsAtBoundary && endsAtBoundary) return true
    start = normalizedTerminal.indexOf(normalizedWorkspace, start + 1)
  }
  return false
}

const TRUST_THIS_WORKSPACE_RE = /\btrust\s+(?:this\s+)?workspace\b/i
const TRUST_WITH_A_RE =
  /(?:\[\s*a\s*\]|\(\s*a\s*\)|\ba\s*[.)\-:])\s*(?:trust\s+(?:this\s+)?workspace)\b|\btrust\s+(?:this\s+)?workspace\b\s*(?:\[\s*a\s*\]|\(\s*a\s*\)|\ba\s*[.)\-:])|\b(?:press|type)\s+(?:the\s+)?(?:key\s+)?["'`[]?a["'`\]]?\s+to\s+trust\s+(?:this\s+)?workspace\b/i

function hasManagedWorktreeOwnership(input: {
  workingDir: string
  worktree?: string
  alreadyHandled: boolean
  interactiveUsed: boolean
}): boolean {
  return Boolean(
    !input.alreadyHandled &&
      !input.interactiveUsed &&
      input.worktree &&
      input.worktree === input.workingDir &&
      isExactManagedWorktreePath(input.worktree) &&
      isExactManagedWorktreePath(input.workingDir)
  )
}

/**
 * Classify Cursor's interactive trust screen. `partial` is deliberately
 * limited to a verified Vertragus worktree, so retrying terminal output cannot
 * affect a user-selected workspace.
 */
export function cursorWorkspaceTrustPrompt(input: {
  output: string
  workingDir: string
  worktree?: string
  alreadyHandled: boolean
  interactiveUsed: boolean
}): CursorWorkspaceTrustPrompt {
  if (!hasManagedWorktreeOwnership(input)) return 'none'

  const text = visibleTerminalText(input.output)
  if (!TRUST_THIS_WORKSPACE_RE.test(text)) return 'none'
  if (!outputMentionsWorkspace(text, input.workingDir) || !TRUST_WITH_A_RE.test(text)) return 'partial'
  return 'ready'
}

/** Detect a verified, complete Cursor trust prompt for the active Vertragus worktree. */
export function shouldAutoTrustCursorWorktree(input: {
  output: string
  workingDir: string
  worktree?: string
  alreadyHandled: boolean
  interactiveUsed: boolean
}): boolean {
  return cursorWorkspaceTrustPrompt(input) === 'ready'
}
