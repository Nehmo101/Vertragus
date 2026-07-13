/**
 * Git worktree isolation: each agent gets its own worktree + branch so
 * parallel (especially Yolo) agents never collide in the same checkout.
 *
 * Worktrees live under <repoRoot>/.orca-worktrees/<sessionId>/<agentId> on
 * branch orca/<sessionId>/<agentId>. Stopping an agent never deletes them;
 * cleanup tooling comes with the diff/merge view in Phase 2.
 */
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { promisify } from 'node:util'
import { dirname, join } from 'node:path'
import { canonicalWorkspacePath } from '@main/agents/workspacePath'

const execFileAsync = promisify(execFile)

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', cwd, ...args], {
    windowsHide: true,
    timeout: 15000
  })
  return stdout.trim()
}

export async function repoRoot(dir: string): Promise<string | null> {
  try {
    return await git(dir, ['rev-parse', '--show-toplevel'])
  } catch {
    return null
  }
}

export async function currentBranch(dir: string): Promise<string | null> {
  try {
    return await git(dir, ['rev-parse', '--abbrev-ref', 'HEAD'])
  } catch {
    return null
  }
}

export interface WorktreeResult {
  path: string
  branch: string
}

function safeIdentityPart(value: string, label: string): string {
  const safe = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  if (!safe) throw new Error(`${label} ergibt keine sichere Git-Identität`)
  return safe
}

/**
 * Build a unique, inspectable identity without consulting or mutating Git.
 * The session id keeps process-local agent ids from colliding after an app
 * restart. Existing branches/worktrees are deliberately never reused.
 */
export function worktreeIdentity(
  root: string,
  agentId: string,
  sessionId: string
): WorktreeResult {
  const safeSession = safeIdentityPart(sessionId, 'Session-ID')
  const safeAgent = safeIdentityPart(agentId, 'Agent-ID')
  return {
    path: join(root, '.orca-worktrees', safeSession, safeAgent),
    branch: `orca/${safeSession}/${safeAgent}`
  }
}

/**
 * Create a fresh isolated worktree for the given agent and app session.
 * A non-Git directory returns null. Git failures are surfaced to the caller;
 * falling back to a shared checkout would silently disable isolation.
 */
export async function createWorktree(
  dir: string,
  agentId: string,
  sessionId: string = randomUUID()
): Promise<WorktreeResult | null> {
  const discoveredRoot = await repoRoot(dir)
  if (!discoveredRoot) return null
  const root = await canonicalWorkspacePath(discoveredRoot)
  const identity = worktreeIdentity(root, agentId, sessionId)
  await mkdir(dirname(identity.path), { recursive: true })
  try {
    await git(root, ['worktree', 'add', '-b', identity.branch, identity.path])
    return { ...identity, path: await canonicalWorkspacePath(identity.path) }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    throw new Error(`Worktree ${identity.branch} konnte nicht erstellt werden: ${detail}`, {
      cause: err
    })
  }
}
