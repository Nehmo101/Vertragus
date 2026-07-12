/**
 * GitHub repository discovery, binding, clone, and local remote validation.
 */
import { execFile } from 'node:child_process'
import { readdir, stat } from 'node:fs/promises'
import { promisify } from 'node:util'
import type {
  GithubRepoBindRequest,
  GithubRepoBindResult,
  GithubRepoLocalCheck,
  GithubRepoResolveResult,
  GithubRepoSearchResult,
  GithubRepoSummary
} from '@shared/ipc'
import type { ProfileCloneStatus, ProfileGithubRepo } from '@shared/profile'
import { githubOwnerFromRemote } from '@main/integrations/github'
import { githubAuthStatus } from '@main/integrations/githubAuth'
import { gitInfo } from '@main/integrations/git'

const execFileAsync = promisify(execFile)

interface RawGhRepo {
  name?: string
  description?: string | null
  isPrivate?: boolean
  url?: string
  defaultBranchRef?: { name?: string }
  owner?: { login?: string }
}

function normalizeRepoSlug(value: string, label: string): string {
  const normalized = value.trim()
  if (!/^[A-Za-z0-9._-]+$/.test(normalized)) {
    throw new Error(`Ungültiger ${label}: ${value}`)
  }
  return normalized
}

export function parseRepoFromRemote(remote: string | undefined): { owner?: string; repo?: string } {
  if (!remote?.trim()) return {}
  const https = remote.trim().match(/github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?$/i)
  if (!https) return { owner: githubOwnerFromRemote(remote) }
  return {
    owner: https[1],
    repo: https[2].replace(/\.git$/i, '')
  }
}

export function remotesMatchBoundRepo(
  remote: string | undefined,
  owner: string,
  repo: string
): boolean {
  const parsed = parseRepoFromRemote(remote)
  return (
    parsed.owner?.toLowerCase() === owner.toLowerCase() &&
    parsed.repo?.toLowerCase() === repo.toLowerCase()
  )
}

function mapGhRepo(row: RawGhRepo, fallbackOwner?: string): GithubRepoSummary | undefined {
  const owner = row.owner?.login ?? fallbackOwner
  const repo = row.name?.trim()
  if (!owner || !repo) return undefined
  const defaultBranch = row.defaultBranchRef?.name?.trim() || 'main'
  return {
    owner,
    repo,
    fullName: `${owner}/${repo}`,
    description: row.description?.trim() || undefined,
    defaultBranch,
    url: row.url?.trim() || `https://github.com/${owner}/${repo}`,
    private: Boolean(row.isPrivate)
  }
}

async function runGhJson<T>(args: string[], timeout = 25_000): Promise<T> {
  await assertGithubAuthenticated()
  const { stdout } = await execFileAsync('gh', args, {
    timeout,
    windowsHide: true,
    maxBuffer: 6 * 1024 * 1024,
    shell: process.platform === 'win32'
  })
  return JSON.parse(stdout || '[]') as T
}

async function assertGithubAuthenticated(): Promise<void> {
  const status = await githubAuthStatus()
  if (!status.authenticated) {
    throw new Error('GitHub-Anmeldung fehlt. Bitte zuerst im Profil oder in der Sidebar verbinden.')
  }
  if (status.needsReauth) {
    throw new Error(
      `GitHub-Scopes unvollständig (${status.missingScopes.join(', ')}). Bitte erneut anmelden.`
    )
  }
}

async function directoryIsEmpty(path: string): Promise<boolean> {
  try {
    const entries = await readdir(path)
    return entries.length === 0
  } catch {
    return true
  }
}

async function ensureParentDir(path: string): Promise<void> {
  const { mkdir } = await import('node:fs/promises')
  const { dirname } = await import('node:path')
  await mkdir(dirname(path), { recursive: true })
}

export async function searchGithubRepos(query: string, limit = 30): Promise<GithubRepoSearchResult> {
  const trimmed = query.trim()
  if (!trimmed) return { repos: [], query: '' }

  if (trimmed.includes('/')) {
    const [ownerRaw, repoRaw] = trimmed.split('/', 2)
    const owner = normalizeRepoSlug(ownerRaw, 'Owner')
    const repo = normalizeRepoSlug(repoRaw, 'Repository')
    const resolved = await resolveGithubRepo(owner, repo)
    return {
      query: trimmed,
      repos: [
        {
          owner: resolved.owner,
          repo: resolved.repo,
          fullName: `${resolved.owner}/${resolved.repo}`,
          defaultBranch: resolved.defaultBranch,
          url: resolved.url,
          private: false
        }
      ]
    }
  }

  const rows = await runGhJson<RawGhRepo[]>([
    'search',
    'repos',
    trimmed,
    '--limit',
    String(Math.min(Math.max(limit, 1), 50)),
    '--json',
    'name,description,isPrivate,url,defaultBranchRef,owner'
  ])
  const repos = rows.map((row) => mapGhRepo(row)).filter((row): row is GithubRepoSummary => Boolean(row))
  return { repos, query: trimmed }
}

export async function resolveGithubRepo(owner: string, repo: string): Promise<GithubRepoResolveResult> {
  const normalizedOwner = normalizeRepoSlug(owner, 'Owner')
  const normalizedRepo = normalizeRepoSlug(repo, 'Repository')
  const payload = await runGhJson<{ default_branch?: string; html_url?: string }>([
    'api',
    `repos/${normalizedOwner}/${normalizedRepo}`
  ])
  const defaultBranch = payload.default_branch?.trim() || 'main'
  return {
    owner: normalizedOwner,
    repo: normalizedRepo,
    defaultBranch,
    url: payload.html_url?.trim() || `https://github.com/${normalizedOwner}/${normalizedRepo}`
  }
}

export async function checkGithubRepoLocal(
  owner: string,
  repo: string,
  localPath: string
): Promise<GithubRepoLocalCheck> {
  const normalizedOwner = normalizeRepoSlug(owner, 'Owner')
  const normalizedRepo = normalizeRepoSlug(repo, 'Repository')
  const path = localPath.trim()
  if (!path) {
    return {
      localPath: path,
      cloneStatus: 'unbound',
      message: 'Kein lokaler Pfad gesetzt.'
    }
  }

  try {
    const info = await stat(path)
    if (!info.isDirectory()) {
      return {
        localPath: path,
        cloneStatus: 'error',
        message: 'Lokaler Pfad ist kein Verzeichnis.'
      }
    }
  } catch {
    return {
      localPath: path,
      cloneStatus: 'unbound',
      message: 'Lokales Verzeichnis existiert noch nicht.'
    }
  }

  const git = await gitInfo(path)
  if (!git.isRepo) {
    const empty = await directoryIsEmpty(path)
    return {
      localPath: path,
      cloneStatus: empty ? 'linked' : 'error',
      message: empty
        ? 'Zielverzeichnis bereit zum Klonen.'
        : 'Verzeichnis ist kein Git-Repository.'
    }
  }

  if (!remotesMatchBoundRepo(git.remote, normalizedOwner, normalizedRepo)) {
    return {
      localPath: path,
      cloneStatus: 'diverged',
      remoteUrl: git.remote,
      message: `origin (${git.remote ?? 'fehlt'}) weicht von ${normalizedOwner}/${normalizedRepo} ab.`
    }
  }

  const defaultBranch = git.defaultBranch ?? ''
  return {
    localPath: path,
    cloneStatus: 'cloned',
    remoteUrl: git.remote,
    message: defaultBranch
      ? `Verbunden · Standardbranch ${defaultBranch}`
      : 'Verbunden mit gebundenem Remote.'
  }
}

async function cloneGithubRepo(owner: string, repo: string, localPath: string): Promise<void> {
  await ensureParentDir(localPath)
  const empty = await directoryIsEmpty(localPath)
  if (!empty) {
    throw new Error(`Klonen abgebrochen: ${localPath} ist nicht leer.`)
  }
  const url = `https://github.com/${owner}/${repo}.git`
  await execFileAsync('git', ['clone', url, localPath], {
    timeout: 10 * 60_000,
    windowsHide: true,
    maxBuffer: 2 * 1024 * 1024
  })
}

export async function bindGithubRepo(req: GithubRepoBindRequest): Promise<GithubRepoBindResult> {
  const owner = normalizeRepoSlug(req.owner, 'Owner')
  const repo = normalizeRepoSlug(req.repo, 'Repository')
  const resolved = await resolveGithubRepo(owner, repo)
  const defaultBranch = req.defaultBranch?.trim() || resolved.defaultBranch
  let localPath = req.localPath?.trim() || ''
  let cloneStatus: ProfileCloneStatus = 'linked'
  let message = `Repository ${owner}/${repo} gebunden.`

  if (req.clone) {
    if (!localPath) {
      throw new Error('Für das Klonen muss ein Zielverzeichnis gewählt werden.')
    }
    await cloneGithubRepo(owner, repo, localPath)
    cloneStatus = 'cloned'
    message = `Repository nach ${localPath} geklont.`
  } else if (localPath) {
    const check = await checkGithubRepoLocal(owner, repo, localPath)
    cloneStatus = check.cloneStatus
    message = check.message
    if (cloneStatus === 'diverged') {
      throw new Error(check.message)
    }
    if (cloneStatus === 'error') {
      throw new Error(check.message)
    }
  }

  const binding: ProfileGithubRepo = {
    owner,
    repo,
    defaultBranch,
    localPath,
    cloneStatus
  }
  const workingDir = localPath || ''
  return { binding, workingDir, message }
}

export const githubRepoInternals = {
  normalizeRepoSlug,
  parseRepoFromRemote,
  remotesMatchBoundRepo,
  mapGhRepo
}
