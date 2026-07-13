import { describe, expect, it } from 'vitest'
import type { GitInfo } from '@shared/ipc'
import {
  buildGitBranchTree,
  compactWorktreePath,
  gitWorkspaceTreeGate
} from './gitWorkspaceTree'

describe('Git workspace tree', () => {
  it.each([
    [{ authResolved: false, githubUsable: false, repoBound: false, isRepo: false }, 'checking-auth'],
    [{ authResolved: true, githubUsable: false, repoBound: true, isRepo: true }, 'needs-auth'],
    [{ authResolved: true, githubUsable: true, repoBound: false, isRepo: true }, 'needs-binding'],
    [{ authResolved: true, githubUsable: true, repoBound: true, isRepo: false }, 'needs-repo'],
    [{ authResolved: true, githubUsable: true, repoBound: true, isRepo: true }, 'ready']
  ] as const)('gates tree data behind GitHub auth and repository binding', (input, expected) => {
    expect(gitWorkspaceTreeGate(input)).toBe(expected)
  })

  it('groups branch worktrees and keeps detached worktrees visible', () => {
    const info: GitInfo = {
      isRepo: true,
      root: 'C:\\repo',
      branch: 'main',
      defaultBranch: 'main',
      branches: ['feature/green', 'main'],
      worktrees: [
        { path: 'C:\\repo', branch: 'main', head: '111', detached: false, bare: false },
        {
          path: 'C:\\repo\\.orca-worktrees\\s\\sub-01',
          branch: 'feature/green',
          head: '222',
          detached: false,
          bare: false,
          locked: 'busy'
        },
        {
          path: 'C:\\repo\\.orca-worktrees\\s\\review',
          head: '333',
          detached: true,
          bare: false
        }
      ]
    }

    const tree = buildGitBranchTree(info)
    expect(tree.branches.map((branch) => branch.name)).toEqual(['main', 'feature/green'])
    expect(tree.branches[1].worktrees[0]).toMatchObject({ branch: 'feature/green', locked: 'busy' })
    expect(tree.detachedWorktrees).toHaveLength(1)
    expect(compactWorktreePath('c:/repo', info.root)).toBe('Haupt-Worktree')
    expect(compactWorktreePath('C:\\repo\\.orca-worktrees\\s\\sub-01')).toBe('s / sub-01')
  })
})