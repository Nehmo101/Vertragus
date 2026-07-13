import { describe, expect, it } from 'vitest'
import { shouldAutoTrustCursorWorktree } from './cursorWorkspaceTrust'

const worktree = 'C:\\git\\UWE\\.orca-worktrees\\session-a\\sub-01'

describe('shouldAutoTrustCursorWorktree', () => {
  it('confirms Cursor trust only for an Orca-created worktree', () => {
    expect(
      shouldAutoTrustCursorWorktree({
        output: `\x1b[33mWorkspace Trust Required\x1b[0m\n${worktree}\n[a] Trust this workspace`,
        workingDir: worktree,
        worktree,
        alreadyHandled: false,
        interactiveUsed: false
      })
    ).toBe(true)
  })

  it('keeps Cursor confirmation for ordinary or already-interacted workspaces', () => {
    const output = `Workspace Trust Required\n${worktree}\n[a] Trust this workspace`
    expect(
      shouldAutoTrustCursorWorktree({
        output,
        workingDir: worktree,
        alreadyHandled: false,
        interactiveUsed: true
      })
    ).toBe(false)
    expect(
      shouldAutoTrustCursorWorktree({
        output,
        workingDir: worktree,
        worktree: 'C:\\different-worktree',
        alreadyHandled: false,
        interactiveUsed: false
      })
    ).toBe(false)
  })
})
