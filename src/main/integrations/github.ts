/**
 * GitHub integration via the authenticated `gh` CLI. Phase 1 adds repo/branch
 * context per agent working directory; Phase 2 adds optional auto-PR after
 * worktree-isolated runs.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { GithubProjectSummary, GithubProjectsResult } from '@shared/ipc'
import { gitInfo } from '@main/integrations/git'

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

export function githubOwnerFromRemote(remote: string | undefined): string | undefined {
  if (!remote) return undefined
  const match = remote
    .trim()
    .match(/^(?:https?:\/\/github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)([^/]+)\//i)
  return match?.[1]
}

function normalizeOwner(owner: string): string {
  const normalized = owner.trim().replace(/^@/, '')
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(normalized)) {
    throw new Error(`Ungültiger GitHub-Owner: ${owner}`)
  }
  return normalized
}

interface RawGithubProject {
  number?: number
  title?: string
  url?: string
  closed?: boolean
}

export function parseGithubProjects(raw: string, owner: string): GithubProjectSummary[] {
  const parsed = JSON.parse(raw || '{}') as RawGithubProject[] | { projects?: RawGithubProject[] }
  const rows = Array.isArray(parsed) ? parsed : parsed.projects ?? []
  return rows
    .filter(
      (row): row is Required<Pick<RawGithubProject, 'number' | 'title' | 'url'>> & RawGithubProject =>
        Number.isInteger(row.number) && Boolean(row.title?.trim()) && Boolean(row.url?.trim())
    )
    .map((row) => ({
      owner,
      number: row.number,
      title: row.title.trim(),
      url: row.url,
      closed: Boolean(row.closed)
    }))
    .sort((a, b) => a.number - b.number)
}

export async function listGithubProjects(
  dir: string,
  ownerOverride?: string
): Promise<GithubProjectsResult> {
  const detected = ownerOverride?.trim()
    ? ownerOverride
    : githubOwnerFromRemote((await gitInfo(dir)).remote)
  if (!detected) {
    throw new Error('Kein GitHub-Owner erkannt. Bitte Owner im Workspace-Profil angeben.')
  }
  const owner = normalizeOwner(detected)
  try {
    await execFileAsync('gh', ['auth', 'status'], { timeout: 8_000, windowsHide: true })
  } catch {
    throw new Error(
      'GitHub-Anmeldung fehlt oder ist abgelaufen. Bitte GitHub in der Provider-Seitenleiste neu verbinden.'
    )
  }
  try {
    const { stdout } = await execFileAsync(
      'gh',
      ['project', 'list', '--owner', owner, '--format', 'json', '--limit', '100'],
      { timeout: 20_000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }
    )
    return { owner, projects: parseGithubProjects(stdout, owner) }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    if (/read:project|missing required scopes/i.test(detail)) {
      throw new Error(
        'GitHub-Boards benötigen Leserechte für Projects. Bitte einmal „gh auth refresh -s read:project“ ausführen.'
      )
    }
    throw new Error(`GitHub-Boards für ${owner} konnten nicht geladen werden: ${detail}`)
  }
}
