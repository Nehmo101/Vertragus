/**
 * GitHub integration via the authenticated `gh` CLI. Phase 1 adds repo/branch
 * context per agent working directory; Phase 2 adds optional auto-PR after
 * worktree-isolated runs.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export interface GithubStatus {
  authenticated: boolean
  account?: string
}

export async function githubStatus(): Promise<GithubStatus> {
  try {
    const { stdout, stderr } = await execFileAsync('gh', ['auth', 'status'], {
      timeout: 6000,
      windowsHide: true,
      shell: process.platform === 'win32'
    })
    const out = stdout || stderr || ''
    const account = out.match(/account\s+(\S+)/i)?.[1]
    return { authenticated: /Logged in to/i.test(out), account }
  } catch {
    return { authenticated: false }
  }
}
