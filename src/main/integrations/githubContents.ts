/**
 * Minimal GitHub REST client (Contents + Git-Data API) for the retro data
 * branch. Writes happen without a local clone; every write path re-checks the
 * branch guard so retro artifacts can never land on main/master or the
 * repository default branch.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readGithubOAuthToken } from '@main/config/secrets'
import { assertSafeRetroBranch } from '@shared/retroSync'

const execFileAsync = promisify(execFile)

const API_BASE = 'https://api.github.com'
const REQUEST_TIMEOUT_MS = 15_000
const CLI_TOKEN_TTL_MS = 5 * 60_000

export interface RepoRef {
  owner: string
  repo: string
  branch: string
}

export interface RepoFile {
  content: string
  sha: string
  size: number
}

let cachedCliToken: { token: string; expiresAt: number } | undefined
const ensuredBranches = new Set<string>()
const knownDefaultBranches = new Map<string, string>()

function repoKey(ref: RepoRef): string {
  return `${ref.owner}/${ref.repo}`
}

export async function resolveGithubToken(): Promise<string> {
  const stored = readGithubOAuthToken()?.trim()
  if (stored) return stored
  if (cachedCliToken && cachedCliToken.expiresAt > Date.now()) return cachedCliToken.token
  try {
    const { stdout } = await execFileAsync('gh', ['auth', 'token'], {
      timeout: 12_000,
      windowsHide: true,
      shell: process.platform === 'win32'
    })
    const token = stdout.trim()
    if (token) {
      cachedCliToken = { token, expiresAt: Date.now() + CLI_TOKEN_TTL_MS }
      return token
    }
  } catch {
    // gh fehlt oder ist abgemeldet — unten einheitlich gemeldet.
  }
  throw new Error('Kein GitHub-Token verfügbar. Bitte zuerst mit GitHub verbinden.')
}

async function githubApi(
  path: string,
  init: { method?: string; body?: string } = {}
): Promise<Response> {
  const token = await resolveGithubToken()
  return fetch(`${API_BASE}${path}`, {
    method: init.method ?? 'GET',
    body: init.body,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      ...(init.body ? { 'Content-Type': 'application/json' } : {})
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  })
}

async function apiError(action: string, response: Response): Promise<Error> {
  let detail = ''
  try {
    const body = (await response.json()) as { message?: string }
    if (body?.message) detail = ` — ${body.message}`
  } catch {
    // Fehlerdetails sind optional.
  }
  return new Error(`GitHub-API ${response.status} bei ${action}${detail}`)
}

function encodePath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/')
}

export async function getRepoFile(ref: RepoRef, path: string): Promise<RepoFile | undefined> {
  const response = await githubApi(
    `/repos/${ref.owner}/${ref.repo}/contents/${encodePath(path)}?ref=${encodeURIComponent(ref.branch)}`
  )
  if (response.status === 404) return undefined
  if (!response.ok) throw await apiError(`Lesen von ${path}`, response)
  const body = (await response.json()) as { content?: string; sha: string; size?: number }
  return {
    content: Buffer.from(body.content ?? '', 'base64').toString('utf8'),
    sha: body.sha,
    size: body.size ?? 0
  }
}

export async function putRepoFile(options: {
  ref: RepoRef
  path: string
  content: string
  message: string
  sha?: string
}): Promise<void> {
  const { ref, path, content, message } = options
  assertSafeRetroBranch(ref.branch, knownDefaultBranches.get(repoKey(ref)))
  const attempt = (sha?: string): Promise<Response> =>
    githubApi(`/repos/${ref.owner}/${ref.repo}/contents/${encodePath(path)}`, {
      method: 'PUT',
      body: JSON.stringify({
        message,
        content: Buffer.from(content, 'utf8').toString('base64'),
        branch: ref.branch,
        ...(sha ? { sha } : {})
      })
    })
  let response = await attempt(options.sha)
  // 409/422 ohne sha: Datei existiert bereits — sha nachladen, genau ein Retry.
  if (!response.ok && !options.sha && (response.status === 409 || response.status === 422)) {
    const existing = await getRepoFile(ref, path)
    if (existing) response = await attempt(existing.sha)
  }
  if (!response.ok) throw await apiError(`Schreiben von ${path}`, response)
}

/**
 * Ensures the retro branch exists, creating it as an orphan (parents: []) on
 * first use so it never shares history with code branches. Re-validates the
 * branch guard against the repository's real default branch.
 */
export async function ensureRetroBranch(ref: RepoRef, bootstrapReadme: string): Promise<void> {
  assertSafeRetroBranch(ref.branch)
  const ensuredKey = `${repoKey(ref)}#${ref.branch}`
  if (ensuredBranches.has(ensuredKey)) return

  const repoResponse = await githubApi(`/repos/${ref.owner}/${ref.repo}`)
  if (!repoResponse.ok) throw await apiError(`Zugriff auf ${repoKey(ref)}`, repoResponse)
  const repoInfo = (await repoResponse.json()) as { default_branch?: string }
  if (repoInfo.default_branch) knownDefaultBranches.set(repoKey(ref), repoInfo.default_branch)
  assertSafeRetroBranch(ref.branch, repoInfo.default_branch)

  const branchResponse = await githubApi(
    `/repos/${ref.owner}/${ref.repo}/branches/${encodeURIComponent(ref.branch)}`
  )
  if (branchResponse.ok) {
    ensuredBranches.add(ensuredKey)
    return
  }
  if (branchResponse.status !== 404) {
    throw await apiError(`Prüfen von Branch ${ref.branch}`, branchResponse)
  }

  const blob = await gitData(ref, 'blobs', { content: bootstrapReadme, encoding: 'utf-8' })
  const tree = await gitData(ref, 'trees', {
    tree: [{ path: 'README.md', mode: '100644', type: 'blob', sha: blob.sha }]
  })
  const commit = await gitData(ref, 'commits', {
    message: 'Retro-Branch initialisiert (Orphan, nur Retro-Daten)',
    tree: tree.sha,
    parents: []
  })
  const refResponse = await githubApi(`/repos/${ref.owner}/${ref.repo}/git/refs`, {
    method: 'POST',
    body: JSON.stringify({ ref: `refs/heads/${ref.branch}`, sha: commit.sha })
  })
  // 422: Branch wurde parallel angelegt — gleichwertig zum Erfolg.
  if (!refResponse.ok && refResponse.status !== 422) {
    throw await apiError(`Anlegen von Branch ${ref.branch}`, refResponse)
  }
  ensuredBranches.add(ensuredKey)
}

async function gitData(
  ref: RepoRef,
  kind: 'blobs' | 'trees' | 'commits',
  body: unknown
): Promise<{ sha: string }> {
  const response = await githubApi(`/repos/${ref.owner}/${ref.repo}/git/${kind}`, {
    method: 'POST',
    body: JSON.stringify(body)
  })
  if (!response.ok) throw await apiError(`git/${kind}`, response)
  return (await response.json()) as { sha: string }
}

/** Nur für Tests: interne Caches zurücksetzen. */
export const githubContentsInternals = {
  reset(): void {
    cachedCliToken = undefined
    ensuredBranches.clear()
    knownDefaultBranches.clear()
  }
}
