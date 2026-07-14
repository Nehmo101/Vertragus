import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { access, mkdir, mkdtemp, open, rm, rmdir } from 'node:fs/promises'
import { constants } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type {
  PanePreflightCheck,
  PanePreflightCheckId,
  PanePreflightReport,
  TaskBlocker
} from '@shared/orchestrator'
import { getProvider, type AgentProviderId } from '@shared/providers'
import { ensureWorktreeDependencies } from '@main/agents/dependencyBootstrap'
import { canonicalWorkspacePath, workspacePathKey } from '@main/agents/workspacePath'
import { resolveLaunch } from '@main/agents/resolveCommand'
import {
  CODEX_RUNTIME_DIR_NAME,
  codexSingleRootEnvironment,
  codexSingleRootSandboxArgs
} from '@main/agents/codexSandbox'

const execFileAsync = promisify(execFile)
const PREFLIGHT_TIMEOUT_MS = 12_000

export interface PanePreflightInput {
  provider: AgentProviderId
  workingDir: string
  worktree?: string
  yolo?: boolean
  engineId?: string
  workspaceSessionId?: string
}

export class PanePreflightError extends Error {
  readonly code = 'pane-preflight-failed'
  constructor(
    message: string,
    readonly report: PanePreflightReport
  ) {
    super(message)
    this.name = 'PanePreflightError'
  }

  blocker(): TaskBlocker {
    return {
      kind: 'infrastructure',
      code: this.code,
      summary: this.message,
      details: this.report.checks
        .filter((check) => check.status === 'failed')
        .map((check) => `${check.id}: ${check.detail}`),
      recoverable: true
    }
  }
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', cwd, ...args], {
    windowsHide: true,
    timeout: PREFLIGHT_TIMEOUT_MS
  })
  return stdout.trim()
}

async function primaryWorktree(cwd: string): Promise<string | undefined> {
  try {
    const output = await git(cwd, ['worktree', 'list', '--porcelain'])
    const first = output.match(/^worktree\s+(.+)$/m)?.[1]
    return first ? await canonicalWorkspacePath(first) : undefined
  } catch {
    return undefined
  }
}

async function check(
  id: PanePreflightCheckId,
  run: () => Promise<{ status?: PanePreflightCheck['status']; detail: string }>
): Promise<PanePreflightCheck> {
  const startedAt = Date.now()
  try {
    const result = await run()
    return {
      id,
      status: result.status ?? 'passed',
      detail: result.detail,
      durationMs: Date.now() - startedAt
    }
  } catch (error) {
    return {
      id,
      status: 'failed',
      detail: error instanceof Error ? error.message : String(error),
      durationMs: Date.now() - startedAt
    }
  }
}

async function writeProbe(directory: string): Promise<void> {
  const path = join(directory, `.orca-preflight-${randomUUID()}.tmp`)
  const handle = await open(path, 'wx', 0o600)
  try {
    await handle.writeFile('orca-preflight\n', 'utf8')
  } finally {
    await handle.close()
    await rm(path, { force: true })
  }
}

/**
 * Exercise Codex's real Windows sandbox bootstrap inside the exact worker
 * workspace. A host-process write probe alone cannot detect restricted-token
 * or split-writable-root failures that only happen in a nested Codex process.
 */
export function codexRuntimeCanaryArgs(workingDir: string): string[] {
  return [
    'sandbox',
    ...codexSingleRootSandboxArgs('win32'),
    '--permission-profile',
    ':workspace',
    '-C',
    workingDir,
    'powershell.exe',
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    "$path = $env:ORCA_CODEX_CANARY_PATH; [System.IO.File]::WriteAllText($path, 'orca-runtime-preflight'); Remove-Item -LiteralPath $path -Force"
  ]
}

async function providerRuntimeCanary(input: PanePreflightInput, workingDir: string): Promise<{
  status?: PanePreflightCheck['status']
  detail: string
}> {
  if (input.provider !== 'codex') {
    return { detail: 'Fuer diesen Provider ist kein separater Runtime-Canary erforderlich.' }
  }
  if (input.yolo) {
    return {
      status: 'warning',
      detail: 'Expliziter Yolo-Modus: Codex umgeht Approval- und Sandbox-Pruefungen.'
    }
  }
  if (process.platform !== 'win32') {
    return {
      status: 'warning',
      detail: 'Der Codex-Runtime-Canary ist derzeit auf den Windows-Sandboxfehler zugeschnitten.'
    }
  }

  const markerPath = join(workingDir, `.orca-codex-runtime-${randomUUID()}.tmp`)
  const runtimeRoot = join(workingDir, CODEX_RUNTIME_DIR_NAME)
  await mkdir(runtimeRoot, { recursive: true })
  let runtimeDir: string | undefined
  try {
    runtimeDir = await mkdtemp(join(runtimeRoot, 'preflight-'))
    const launch = await resolveLaunch('codex', codexRuntimeCanaryArgs(workingDir))
    await execFileAsync(launch.file, launch.args, {
      cwd: workingDir,
      env: codexSingleRootEnvironment(runtimeDir, {
        ...process.env,
        ORCA_CODEX_CANARY_PATH: markerPath
      }),
      windowsHide: true,
      timeout: PREFLIGHT_TIMEOUT_MS
    })
  } finally {
    await rm(markerPath, { force: true })
    if (runtimeDir) await rm(runtimeDir, { recursive: true, force: true })
    await rmdir(runtimeRoot).catch(() => undefined)
  }
  return { detail: `Codex-Sandbox startet und schreibt im Worker-Worktree: ${workingDir}` }
}

export async function runPanePreflight(input: PanePreflightInput): Promise<PanePreflightReport> {
  const startedAt = Date.now()
  const canonicalWorkspace = await canonicalWorkspacePath(input.workingDir)
  const repositoryRoot = await primaryWorktree(canonicalWorkspace)

  const checks = await Promise.all([
    check('provider', async () => {
      const provider = getProvider(input.provider)
      if (!provider) throw new Error(`Unbekannter Provider: ${input.provider}`)
      const launch = await resolveLaunch(provider.command, provider.versionArgs)
      const { stdout, stderr } = await execFileAsync(launch.file, launch.args, {
        cwd: canonicalWorkspace,
        windowsHide: true,
        timeout: PREFLIGHT_TIMEOUT_MS
      })
      const version = (stdout || stderr || '').split(/\r?\n/).find(Boolean)?.trim() ?? 'bereit'
      return { detail: `${provider.label} startet noninteraktiv: ${version}` }
    }),
    check('provider-runtime', () => providerRuntimeCanary(input, canonicalWorkspace)),
    check('workspace', async () => {
      await access(canonicalWorkspace, constants.R_OK | constants.W_OK)
      await writeProbe(canonicalWorkspace)
      return { detail: `Lesen/Schreiben bestätigt: ${canonicalWorkspace}` }
    }),
    check('git-common-dir', async () => {
      try {
        const common = await git(canonicalWorkspace, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
        const canonicalCommon = await canonicalWorkspacePath(common)
        await access(canonicalCommon, constants.R_OK | constants.W_OK)
        await writeProbe(canonicalCommon)
        return { detail: `Zentrale Git-Operationen möglich: ${canonicalCommon}` }
      } catch (error) {
        if (!repositoryRoot) {
          return { status: 'warning', detail: 'Kein Git-Repository; Git-Checks sind nicht anwendbar.' }
        }
        throw error
      }
    }),
    check('dependencies', async () => {
      const result = await ensureWorktreeDependencies(repositoryRoot ?? canonicalWorkspace, canonicalWorkspace)
      return { detail: result.detail }
    }),
    check('toolchain', async () => {
      const version = await git(canonicalWorkspace, ['--version'])
      return { detail: `${version}; Package-Toolchain wurde beim Dependency-Check verifiziert.` }
    }),
    check('identity', async () => {
      if (!input.engineId || !input.workspaceSessionId) {
        return {
          status: 'warning',
          detail: 'Pool-Preflight ohne Laufbindung; Dispatch prüft Engine- und Workspace-ID erneut.'
        }
      }
      return {
        detail: `Engine ${input.engineId} · Workspace ${input.workspaceSessionId} · ${workspacePathKey(canonicalWorkspace)}`
      }
    })
  ])

  const report: PanePreflightReport = {
    status: checks.some((entry) => entry.status === 'failed') ? 'failed' : 'passed',
    provider: input.provider,
    workspaceId: workspacePathKey(canonicalWorkspace),
    engineId: input.engineId,
    workspaceSessionId: input.workspaceSessionId,
    startedAt,
    completedAt: Date.now(),
    checks
  }
  if (report.status === 'failed') {
    const failed = checks.filter((entry) => entry.status === 'failed')
    throw new PanePreflightError(
      `Pane-Preflight fehlgeschlagen: ${failed.map((entry) => entry.id).join(', ')}`,
      report
    )
  }
  return report
}
