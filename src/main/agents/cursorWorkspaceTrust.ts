import { stripAnsi } from '@main/agents/limitSignals'

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
  if (input.alreadyHandled || input.interactiveUsed) return false
  // A regular user-selected workspace must always retain Cursor's own prompt.
  if (!input.worktree || input.worktree !== input.workingDir) return false

  // Cursor uses ANSI styling in its TUI, so match its visible text only.
  const text = stripAnsi(input.output)
  return (
    text.includes('Workspace Trust Required') &&
    text.includes('[a] Trust this workspace') &&
    text.includes(input.workingDir)
  )
}
