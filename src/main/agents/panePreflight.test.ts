import { describe, expect, it } from 'vitest'
import { codexRuntimeCanaryArgs } from './panePreflight'

describe('Codex runtime preflight', () => {
  it('runs the sandbox canary in the exact worker workspace without a model call', () => {
    const args = codexRuntimeCanaryArgs('C:\\repo\\.orca-worktrees\\worker')

    expect(args).toEqual([
      'sandbox',
      '-c',
      'sandbox_workspace_write.exclude_slash_tmp=true',
      '--permission-profile',
      ':workspace',
      '-C',
      'C:\\repo\\.orca-worktrees\\worker',
      'powershell.exe',
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      expect.stringMatching(/ORCA_CODEX_CANARY_PATH.*WriteAllText/)
    ])
    expect(args).not.toContain('exec')
    expect(args).not.toContain('--dangerously-bypass-approvals-and-sandbox')
  })
})
