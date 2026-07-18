import { describe, expect, it } from 'vitest'
import {
  cursorWorkspaceTrustPrompt,
  isExactOrcaWorktreePath,
  isOrcaWorktreePath,
  normalizeWorkspacePath,
  shouldAutoTrustCursorWorktree
} from './cursorWorkspaceTrust'

const worktree = 'C:\\git\\demo-app\\.orca-worktrees\\session-a\\sub-01'

describe('shouldAutoTrustCursorWorktree', () => {
  it('confirms Cursor trust only for a Vertragus-created worktree', () => {
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

  it.each([
    `[A] Trust this workspace\n${worktree}`,
    `${worktree}\n(a) Trust this workspace`,
    `${worktree.replace(/\\/g, '/')}\nPress 'a' to trust this workspace`,
    `\x1b[2K${worktree}\r\nA)\x1b[1m Trust this workspace\x1b[0m`
  ])('accepts ANSI and Cursor prompt variants', (output) => {
    expect(
      shouldAutoTrustCursorWorktree({
        output,
        workingDir: worktree,
        worktree,
        alreadyHandled: false,
        interactiveUsed: false
      })
    ).toBe(true)
  })

  it('does not let canonicalization turn a path alias into trusted ownership', () => {
    expect(normalizeWorkspacePath(worktree)).toBe('c:/git/demo-app/.orca-worktrees/session-a/sub-01')
    const alias = 'C:/git/UWE/.orca-worktrees/session-a/./sub-01'
    expect(isExactOrcaWorktreePath(alias)).toBe(false)
    expect(
      shouldAutoTrustCursorWorktree({
        output: `Trust this workspace\n[a]\nC:/git/UWE/.orca-worktrees/session-a/sub-01`,
        workingDir: alias,
        worktree,
        alreadyHandled: false,
        interactiveUsed: false
      })
    ).toBe(false)
  })

  it('waits for incomplete trust screens without accepting them', () => {
    expect(
      cursorWorkspaceTrustPrompt({
        output: 'Workspace Trust Required\nTrust this workspace',
        workingDir: worktree,
        worktree,
        alreadyHandled: false,
        interactiveUsed: false
      })
    ).toBe('partial')
  })

  it('does not confirm when Cursor shows the worktree only as a larger lookalike path', () => {
    expect(
      shouldAutoTrustCursorWorktree({
        output: `Workspace Trust Required\n${worktree}-old\n[a] Trust this workspace`,
        workingDir: worktree,
        worktree,
        alreadyHandled: false,
        interactiveUsed: false
      })
    ).toBe(false)
  })

  it('accepts a later exact path after an earlier lookalike occurrence', () => {
    expect(
      shouldAutoTrustCursorWorktree({
        output: `cached=${worktree}-old\nWorkspace Trust Required\n${worktree}\n[a] Trust this workspace`,
        workingDir: worktree,
        worktree,
        alreadyHandled: false,
        interactiveUsed: false
      })
    ).toBe(true)
  })

  it('keeps Cursor confirmation for ordinary, malformed, or already-interacted workspaces', () => {
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
    expect(
      shouldAutoTrustCursorWorktree({
        output,
        workingDir: 'C:\\Users\\user\\project',
        worktree: 'C:\\Users\\user\\project',
        alreadyHandled: false,
        interactiveUsed: false
      })
    ).toBe(false)
    expect(
      shouldAutoTrustCursorWorktree({
        output: `C:\\git\\demo-app\\.orca-worktrees\\session-a\\sub-01\\nested\n[a] Trust this workspace`,
        workingDir: 'C:\\git\\demo-app\\.orca-worktrees\\session-a\\sub-01\\nested',
        worktree: 'C:\\git\\demo-app\\.orca-worktrees\\session-a\\sub-01\\nested',
        alreadyHandled: false,
        interactiveUsed: false
      })
    ).toBe(false)
    expect(isOrcaWorktreePath('C:\\git\\demo-app\\.orca-worktrees\\session-a\\sub-01\\nested')).toBe(false)
  })

  it.each([
    ['relative worktree', '.orca-worktrees\\session-a\\sub-01'],
    ['user workspace', 'C:\\Users\\user\\project'],
    ['nested path', `${worktree}\\nested`],
    ['traversal after the worktree', `${worktree}\\..\\sub-01`],
    ['symlink-like traversal alias', `${worktree}\\link\\..\\sub-01`],
    ['traversal before the Vertragus directory', 'C:\\git\\demo-app\\..\\UWE\\.orca-worktrees\\session-a\\sub-01'],
    ['current-directory alias', `${worktree}\\.`],
    ['trailing separator alias', `${worktree}\\`],
    ['duplicate-separator alias', 'C:\\git\\demo-app\\.orca-worktrees\\session-a\\\\sub-01'],
    ['Windows device path', '\\\\?\\C:\\git\\demo-app\\.orca-worktrees\\session-a\\sub-01'],
    ['network path', '\\\\server\\share\\.orca-worktrees\\session-a\\sub-01']
  ])('rejects %s even when Cursor renders a trust prompt', (_name, unsafePath) => {
    expect(isExactOrcaWorktreePath(unsafePath)).toBe(false)
    expect(
      shouldAutoTrustCursorWorktree({
        output: `Workspace Trust Required\n${unsafePath}\n[a] Trust this workspace`,
        workingDir: unsafePath,
        worktree: unsafePath,
        alreadyHandled: false,
        interactiveUsed: false
      })
    ).toBe(false)
  })

  it('waits for split output, then accepts the complete ANSI-styled Vertragus prompt', () => {
    const firstChunk = '\x1b[33mWorkspace Trust Required\x1b[0m\r\n'
    expect(
      shouldAutoTrustCursorWorktree({
        output: firstChunk,
        workingDir: worktree,
        worktree,
        alreadyHandled: false,
        interactiveUsed: false
      })
    ).toBe(false)
    expect(
      shouldAutoTrustCursorWorktree({
        output: `${firstChunk}${worktree}\n[a] Trust this workspace`,
        workingDir: worktree,
        worktree,
        alreadyHandled: false,
        interactiveUsed: false
      })
    ).toBe(true)
  })

  it('rejects a manipulated working directory even with a valid Vertragus worktree record', () => {
    const manipulatedDir = `${worktree}\\nested`
    expect(
      shouldAutoTrustCursorWorktree({
        output: `Workspace Trust Required\n${manipulatedDir}\n[a] Trust this workspace`,
        workingDir: manipulatedDir,
        worktree,
        alreadyHandled: false,
        interactiveUsed: false
      })
    ).toBe(false)
  })
})

describe('vertragus worktree namespace ownership', () => {
  const newWorktree = 'C:\\git\\demo-app\\.vertragus-worktrees\\session-a\\sub-01'

  it('grants auto-trust for a new .vertragus-worktrees checkout', () => {
    expect(isExactOrcaWorktreePath(newWorktree)).toBe(true)
    expect(isOrcaWorktreePath(newWorktree)).toBe(true)
    expect(
      shouldAutoTrustCursorWorktree({
        output: `\x1b[33mWorkspace Trust Required\x1b[0m\n${newWorktree}\n[a] Trust this workspace`,
        workingDir: newWorktree,
        worktree: newWorktree,
        alreadyHandled: false,
        interactiveUsed: false
      })
    ).toBe(true)
  })

  it.each([
    ['lookalike without the leading dot', 'C:\\git\\demo-app\\vertragus-worktrees\\session-a\\sub-01'],
    ['nested path', `${newWorktree}\\nested`],
    ['traversal after the worktree', `${newWorktree}\\..\\sub-01`],
    ['current-directory alias', `${newWorktree}\\.`],
    ['trailing separator alias', `${newWorktree}\\`],
    ['traversal before the marker', 'C:\\git\\demo-app\\..\\UWE\\.vertragus-worktrees\\session-a\\sub-01'],
    ['Windows device path', '\\\\?\\C:\\git\\demo-app\\.vertragus-worktrees\\session-a\\sub-01']
  ])('never auto-trusts %s under the new marker', (_name, unsafePath) => {
    expect(isExactOrcaWorktreePath(unsafePath)).toBe(false)
    expect(
      shouldAutoTrustCursorWorktree({
        output: `Workspace Trust Required\n${unsafePath}\n[a] Trust this workspace`,
        workingDir: unsafePath,
        worktree: unsafePath,
        alreadyHandled: false,
        interactiveUsed: false
      })
    ).toBe(false)
  })
})
