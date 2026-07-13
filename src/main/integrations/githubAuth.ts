/**
 * Structured GitHub authentication: browser OAuth (device flow when configured)
 * with gh --web fallback. Tokens stay in safeStorage or gh's credential store.
 */
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { shell } from 'electron'
import type { GithubAuthMethod, GithubAuthStatus } from '@shared/ipc'
import {
  clearGithubOAuthToken,
  githubOAuthClientId,
  readGithubOAuthToken,
  writeGithubOAuthToken
} from '@main/config/secrets'

const execFileAsync = promisify(execFile)

export const GITHUB_REQUIRED_SCOPES = ['repo', 'read:org', 'project', 'workflow'] as const

interface GhAuthProbe {
  authenticated: boolean
  account?: string
  scopes: string[]
  hostname?: string
}

interface DeviceCodeResponse {
  device_code: string
  user_code: string
  verification_uri: string
  expires_in: number
  interval: number
}

interface DeviceTokenResponse {
  access_token?: string
  token_type?: string
  scope?: string
  error?: string
  error_description?: string
}

export function parseGhAuthStatus(output: string): GhAuthProbe {
  const lines = output.split(/\r?\n/)
  let authenticated = false
  let account: string | undefined
  const scopes: string[] = []
  let hostname: string | undefined

  for (const line of lines) {
    const host = line.match(/^([\w.-]+)$/)
    if (host && !line.includes(' ')) {
      hostname = host[1]
      continue
    }
    if (/logged in to/i.test(line)) authenticated = true
    const accountMatch = line.match(/account\s+(\S+)/i)
    if (accountMatch) account = accountMatch[1]
    const scopeMatch = line.match(/token scopes:\s*(.+)$/i)
    if (scopeMatch) {
      const quoted = [...scopeMatch[1].matchAll(/'([^']+)'/g)].map((match) => match[1].trim())
      scopes.push(...quoted.filter(Boolean))
    }
  }

  return { authenticated, account, scopes, hostname }
}

export function missingGithubScopes(scopes: string[]): string[] {
  const present = new Set(scopes.map((scope) => scope.toLowerCase()))
  return GITHUB_REQUIRED_SCOPES.filter((required) => !present.has(required))
}

export function buildGithubAuthStatus(input: {
  authenticated: boolean
  method: GithubAuthMethod
  account?: string
  scopes?: string[]
  oauthConfigured?: boolean
  detail?: string
}): GithubAuthStatus {
  const account = input.account?.trim() || undefined
  const scopes = (input.scopes ?? []).map((scope) => scope.trim()).filter(Boolean)
  const missingScopes = missingGithubScopes(scopes)
  // `authenticated` describes a verified credential/account. Missing scopes
  // are represented independently by `needsReauth`; callers gate privileged
  // GitHub actions on both fields.
  const authenticated = Boolean(input.authenticated && account)
  const needsReauth = Boolean(authenticated && missingScopes.length > 0)
  return {
    authenticated,
    method: authenticated ? input.method : 'none',
    account: authenticated ? account : undefined,
    scopes,
    missingScopes,
    needsReauth,
    oauthConfigured: input.oauthConfigured ?? Boolean(githubOAuthClientId()),
    detail: needsReauth ? 'GitHub-Anmeldung unvollständig. Bitte erneut anmelden.' : input.detail
  }
}

async function runGh(args: string[], timeout = 12_000): Promise<string> {
  const { stdout, stderr } = await execFileAsync('gh', args, {
    timeout,
    windowsHide: true,
    shell: process.platform === 'win32'
  })
  return (stdout || stderr || '').trim()
}

async function probeGhAuth(): Promise<GhAuthProbe> {
  try {
    return parseGhAuthStatus(await runGh(['auth', 'status']))
  } catch {
    return { authenticated: false, scopes: [] }
  }
}

async function probeOAuthUser(token: string): Promise<{ login: string; scopes: string[] }> {
  const normalizedToken = token.trim()
  if (!normalizedToken) {
    throw new Error('OAuth-Token ist leer.')
  }
  const response = await fetch('https://api.github.com/user', {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${normalizedToken}`,
      'X-GitHub-Api-Version': '2022-11-28'
    },
    signal: AbortSignal.timeout(12_000)
  })
  if (!response.ok) {
    throw new Error(`GitHub-API ${response.status}`)
  }
  const user = (await response.json()) as { login?: string }
  const scopeHeader = response.headers.get('x-oauth-scopes') ?? ''
  const scopes = scopeHeader
    .split(',')
    .map((scope) => scope.trim())
    .filter(Boolean)
  const login = user.login?.trim()
  if (!login) {
    throw new Error('GitHub-OAuth-Antwort enthält kein Konto.')
  }
  return { login, scopes }
}

async function syncTokenToGh(token: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn('gh', ['auth', 'login', '--with-token'], {
      windowsHide: true,
      stdio: ['pipe', 'ignore', 'pipe'],
      shell: process.platform === 'win32'
    })
    let err = ''
    child.stderr.on('data', (chunk: Buffer) => {
      err += chunk.toString()
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(err.trim() || `gh auth login --with-token exit ${code}`))
    })
    child.stdin.write(`${token}\n`)
    child.stdin.end()
  })
}

async function requestDeviceCode(clientId: string): Promise<DeviceCodeResponse> {
  const body = new URLSearchParams({
    client_id: clientId,
    scope: GITHUB_REQUIRED_SCOPES.join(' ')
  })
  const response = await fetch('https://github.com/login/device/code', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
    signal: AbortSignal.timeout(15_000)
  })
  if (!response.ok) {
    throw new Error(`Device-Code-Anfrage fehlgeschlagen (${response.status}).`)
  }
  return (await response.json()) as DeviceCodeResponse
}

async function pollDeviceToken(
  clientId: string,
  deviceCode: string,
  intervalSec: number,
  expiresInSec: number
): Promise<string> {
  const deadline = Date.now() + expiresInSec * 1000
  let waitMs = Math.max(intervalSec, 5) * 1000
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, waitMs))
    const body = new URLSearchParams({
      client_id: clientId,
      device_code: deviceCode,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code'
    })
    const response = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(15_000)
    })
    const payload = (await response.json()) as DeviceTokenResponse
    if (payload.access_token) return payload.access_token
    if (payload.error === 'authorization_pending') continue
    if (payload.error === 'slow_down') {
      waitMs += 5000
      continue
    }
    throw new Error(payload.error_description || payload.error || 'OAuth-Token nicht erhalten.')
  }
  throw new Error('GitHub-Geräteanmeldung abgelaufen. Bitte erneut versuchen.')
}

async function loginWithDeviceFlow(clientId: string): Promise<GithubAuthStatus> {
  const device = await requestDeviceCode(clientId)
  const verifyUrl = `${device.verification_uri}?auto=true`
  await shell.openExternal(verifyUrl)
  const token = await pollDeviceToken(clientId, device.device_code, device.interval, device.expires_in)
  const user = await probeOAuthUser(token)
  writeGithubOAuthToken(token, { account: user.login, scopes: user.scopes })
  try {
    await syncTokenToGh(token)
  } catch {
    // gh may be missing; OAuth token still works for API calls we proxy later.
  }
  return buildGithubAuthStatus({
    authenticated: true,
    method: 'oauth',
    account: user.login,
    scopes: user.scopes,
    oauthConfigured: true,
    detail: `Angemeldet als ${user.login} (OAuth)`
  })
}

async function loginWithGhWeb(): Promise<GithubAuthStatus> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      'gh',
      [
        'auth',
        'login',
        '--web',
        '--hostname',
        'github.com',
        '--git-protocol',
        'https',
        '--scopes',
        GITHUB_REQUIRED_SCOPES.join(',')
      ],
      {
        windowsHide: true,
        stdio: ['pipe', 'ignore', 'pipe'],
        shell: process.platform === 'win32'
      }
    )
    let err = ''
    child.stderr.on('data', (chunk: Buffer) => {
      err += chunk.toString()
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(err.trim() || `gh auth login --web exit ${code}`))
    })
    child.stdin.write('\n')
    child.stdin.end()
  })
  const gh = await probeGhAuth()
  return buildGithubAuthStatus({
    authenticated: gh.authenticated,
    method: 'gh-cli',
    account: gh.account,
    scopes: gh.scopes,
    detail: gh.authenticated
      ? `Angemeldet als ${gh.account ?? 'GitHub'} (gh CLI)`
      : 'GitHub-Anmeldung unvollständig.'
  })
}

export async function githubAuthStatus(): Promise<GithubAuthStatus> {
  const oauthConfigured = Boolean(githubOAuthClientId())
  const stored = readGithubOAuthToken()
  if (stored?.trim()) {
    try {
      const user = await probeOAuthUser(stored)
      return buildGithubAuthStatus({
        authenticated: true,
        method: 'oauth',
        account: user.login,
        scopes: user.scopes,
        oauthConfigured,
        detail: `Angemeldet als ${user.login} (OAuth)`
      })
    } catch {
      clearGithubOAuthToken()
    }
  } else if (stored !== undefined) {
    clearGithubOAuthToken()
  }

  const gh = await probeGhAuth()
  if (gh.authenticated) {
    return buildGithubAuthStatus({
      authenticated: true,
      method: 'gh-cli',
      account: gh.account,
      scopes: gh.scopes,
      oauthConfigured,
      detail: gh.account ? `Angemeldet als ${gh.account} (gh CLI)` : 'GitHub über gh CLI verbunden'
    })
  }

  return buildGithubAuthStatus({
    authenticated: false,
    method: 'none',
    oauthConfigured,
    detail: oauthConfigured
      ? 'Nicht angemeldet. Browser-OAuth verfügbar.'
      : 'Nicht angemeldet. Fallback: gh --web oder Terminal-Login.'
  })
}

export async function githubAuthLogin(options?: {
  /** Open gh login in a visible Orca PTY instead of a headless gh --web process. */
  useTerminalLogin?: () => Promise<void>
}): Promise<GithubAuthStatus> {
  const clientId = githubOAuthClientId()
  if (clientId) {
    try {
      return await loginWithDeviceFlow(clientId)
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      throw new Error(`GitHub-OAuth fehlgeschlagen: ${detail}`)
    }
  }
  if (options?.useTerminalLogin) {
    await options.useTerminalLogin()
    const status = await githubAuthStatus()
    return {
      ...status,
      detail:
        'GitHub-Login im Orca-Terminal geöffnet — folge den Anweisungen der gh CLI im sichtbaren Fenster.'
    }
  }
  try {
    return await loginWithGhWeb()
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(
      `GitHub-Web-Login fehlgeschlagen: ${detail}. Optional ORCA_GITHUB_OAUTH_CLIENT_ID setzen oder Terminal-Login nutzen.`
    )
  }
}

export async function githubAuthLogout(): Promise<GithubAuthStatus> {
  clearGithubOAuthToken()
  try {
    await runGh(['auth', 'logout', '--hostname', 'github.com'])
  } catch {
    // gh may already be logged out.
  }
  return githubAuthStatus()
}

export const githubAuthInternals = {
  parseGhAuthStatus,
  missingGithubScopes,
  buildGithubAuthStatus,
  probeOAuthUser
}
