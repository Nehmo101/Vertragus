import { join, posix, win32 } from 'node:path'
import { ensureWorktreeDependencies } from '@main/agents/dependencyBootstrap'
import type { AutoPrConfig } from '@shared/profile'
import {
  assertSecurityGate,
  SecurityGateError,
  type SecurityGateReport
} from '../securityGate'
import {
  formatGitleaksFindings,
  scanStagedWithGitleaks,
  type GitleaksScanResult
} from './gitleaksGate'
import { execAsync, MAX_OUTPUT, repositoryRoot } from './gitPlumbing'
import { WORKTREE_CONTAINER } from '@main/agents/worktree'

/**
 * A gate that fails because its TOOLING is missing (eslint/prisma not found in
 * a fresh worktree) is an infrastructure problem, not a finding against the
 * worker's code. Retros repeatedly graded such runs as model failures.
 */
const GATE_INFRASTRUCTURE_PATTERNS = [
  /command not found/i,
  /not recognized as an internal or external command/i,
  /konnte nicht gefunden werden/i,
  /cannot find module/i,
  /\bENOENT\b/,
  // esbuild fails to spawn its native child under the codex restricted-token
  // sandbox. The retro analysis already treats EPERM as infra (runAnalysis.ts),
  // so the gate must classify it the same way instead of grading green code as
  // a model failure.
  /\bEPERM\b/,
  /esbuild.*(?:spawn|EPERM)/i
]

export class QualityGateError extends Error {
  readonly code = 'quality-gate-failed'
  readonly infrastructure: boolean
  constructor(readonly command: string, detail: string) {
    super(`Quality Gate fehlgeschlagen: ${command}\n${detail}`)
    this.name = 'QualityGateError'
    this.infrastructure = GATE_INFRASTRUCTURE_PATTERNS.some((pattern) => pattern.test(detail))
  }
}

export function assertDiffLooksSafe(diff: string): void {
  assertSecurityGate(diff)
}

/**
 * A staged secret — or a configured but unusable gitleaks — blocks the commit
 * outright. Unlike SecurityGateError there is deliberately no needs-work
 * rescue commit for this class: secret-bearing changes must never be
 * committed anywhere, not even as partial work.
 */
export class SecretScanGateError extends Error {
  readonly code = 'secret-scan-blocked'
  constructor(readonly problems: readonly string[]) {
    super(`Secret-Scan hat den Commit blockiert:\n${problems.join('\n')}`)
    this.name = 'SecretScanGateError'
  }
}

export const GITLEAKS_UNAVAILABLE_MESSAGE =
  'gitleaks ist konfiguriert, aber nicht installiert — der Secret-Scan kann nicht laufen. ' +
  'gitleaks installieren oder autoPr.secretScanner auf "builtin" stellen.'

export interface SecretScanDeps {
  scanStaged(worktree: string): Promise<GitleaksScanResult>
}

/**
 * Combined secret/security gate for staged task changes, honoring
 * AutoPrConfig.secretScanner:
 * - 'builtin' (default, also for legacy configs without the field): exactly
 *   today's assertSecurityGate behavior — gitleaks is never invoked.
 * - 'gitleaks': the built-in added-line secret regexes are skipped and
 *   gitleaks is authoritative for secrets; surface/negative-test analysis
 *   still runs unchanged.
 * - 'both': built-in regexes AND gitleaks run; their findings are merged into
 *   one blocking error.
 * A configured but unavailable or failing gitleaks always blocks (fail
 * closed) — never a silent pass.
 */
export async function assertSecretScanGates(
  worktree: string,
  stagedDiff: string,
  config: Pick<AutoPrConfig, 'secretScanner' | 'securityGateExcludes'>,
  deps: SecretScanDeps = { scanStaged: scanStagedWithGitleaks }
): Promise<SecurityGateReport> {
  const scanner = config.secretScanner ?? 'builtin'
  if (scanner === 'builtin') {
    return assertSecurityGate(stagedDiff, { excludePaths: config.securityGateExcludes })
  }

  const problems: string[] = []
  let surfaceError: SecurityGateError | undefined
  let report: SecurityGateReport | undefined
  try {
    report = assertSecurityGate(stagedDiff, {
      excludePaths: config.securityGateExcludes,
      skipAddedLineSecretScan: scanner === 'gitleaks'
    })
  } catch (error) {
    // Surface findings keep their classified error (needs-work path); any
    // other throw here is the built-in secret scan or the oversized-diff guard.
    if (error instanceof SecurityGateError) surfaceError = error
    else problems.push(error instanceof Error ? error.message : String(error))
  }

  const outcome = await deps.scanStaged(worktree)
  if (outcome.status === 'unavailable') problems.push(GITLEAKS_UNAVAILABLE_MESSAGE)
  else if (outcome.status === 'error') problems.push(outcome.message)
  else if (outcome.status === 'findings') problems.push(formatGitleaksFindings(outcome.findings))

  if (problems.length > 0) throw new SecretScanGateError(problems)
  if (surfaceError) throw surfaceError
  // Unreachable: no problems and no surface error implies the report exists.
  if (!report) throw new SecretScanGateError(['Security-Gate-Report fehlt unerwartet.'])
  return report
}

export function qualityGateShellCommand(
  cwd: string,
  command: string,
  platform: NodeJS.Platform = process.platform
): string {
  if (platform === 'win32') {
    const localBin = win32.join(cwd, 'node_modules', '.bin').replace(/'/g, "''")
    return `& { $env:PATH = '${localBin};' + $env:PATH; ${command} }`
  }
  const localBin = posix.join(cwd, 'node_modules', '.bin').replace(/'/g, "'\"'\"'")
  return `export PATH='${localBin}':"$PATH"; ${command}`
}

interface QualityGateRuntime {
  inheritedEnv: NodeJS.ProcessEnv
  platform: NodeJS.Platform
}

export function qualityGateEnvironment(
  cwd: string,
  workspaceRoot: string,
  inheritedEnv: NodeJS.ProcessEnv,
  platform: NodeJS.Platform
): NodeJS.ProcessEnv {
  const pathKey = platform === 'win32'
    ? Object.keys(inheritedEnv).find((key) => key.toLowerCase() === 'path') ?? 'Path'
    : 'PATH'
  const separator = platform === 'win32' ? ';' : ':'
  const binaryPaths = [join(cwd, 'node_modules', '.bin')]
  const workspaceBinaryPath = join(workspaceRoot, 'node_modules', '.bin')
  if (workspaceBinaryPath !== binaryPaths[0]) binaryPaths.push(workspaceBinaryPath)
  const inheritedPath = inheritedEnv[pathKey]
  if (inheritedPath) binaryPaths.push(inheritedPath)
  return { ...inheritedEnv, [pathKey]: binaryPaths.join(separator) }
}

export async function runQualityGates(
  cwd: string,
  gates: string[],
  workspaceRoot = cwd,
  runtime: QualityGateRuntime = {
    inheritedEnv: process.env,
    platform: process.platform
  }
): Promise<void> {
  const env = qualityGateEnvironment(
    cwd,
    workspaceRoot,
    runtime.inheritedEnv,
    runtime.platform
  )
  for (const command of gates) {
    try {
      await execAsync(command, {
        cwd,
        env,
        windowsHide: true,
        timeout: 15 * 60_000,
        maxBuffer: MAX_OUTPUT,
        shell: runtime.platform === 'win32' ? 'powershell.exe' : '/bin/sh'
      })
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      throw new QualityGateError(command, detail)
    }
  }
}

export interface IntegrationQualityGateDeps {
  bootstrap(repositoryRoot: string, workingDir: string): Promise<unknown>
  runGates(cwd: string, gates: string[], workspaceRoot?: string): Promise<void>
}

function assertManagedIntegrationPath(repositoryRoot: string, integrationPath: string): void {
  const pathApi = win32.isAbsolute(repositoryRoot) || win32.isAbsolute(integrationPath)
    ? win32
    : posix
  const integrationRoot = pathApi.resolve(repositoryRoot, WORKTREE_CONTAINER, 'integration')
  const candidate = pathApi.resolve(integrationPath)
  const relativePath = pathApi.relative(integrationRoot, candidate)
  if (
    !relativePath ||
    relativePath === '..' ||
    relativePath.startsWith('..' + pathApi.sep) ||
    pathApi.isAbsolute(relativePath)
  ) {
    throw new QualityGateError(
      'Dependency-Bootstrap',
      'Integration-Worktree liegt nicht innerhalb des verwalteten Integration-Verzeichnisses.'
    )
  }
}

export async function runIntegrationQualityGates(
  repositoryRoot: string,
  integrationPath: string,
  gates: string[],
  deps: IntegrationQualityGateDeps = {
    bootstrap: ensureWorktreeDependencies,
    runGates: runQualityGates
  }
): Promise<void> {
  assertManagedIntegrationPath(repositoryRoot, integrationPath)
  try {
    await deps.bootstrap(repositoryRoot, integrationPath)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new QualityGateError(
      'Dependency-Bootstrap',
      `Dependencies für den Integration-Worktree konnten nicht bereitgestellt werden: ${detail}`
    )
  }
  await deps.runGates(integrationPath, gates, repositoryRoot)
}

/**
 * Infrastruktur-Gate-Fehler (fehlendes eslint/prisma im frischen Worktree)
 * bekommen genau einen Bootstrap-Versuch, bevor sie als Blocker zählen.
 */
export async function runGatesWithBootstrapRetry(worktree: string, gates: string[]): Promise<void> {
  try {
    await runQualityGates(worktree, gates)
  } catch (error) {
    if (!(error instanceof QualityGateError) || !error.infrastructure) throw error
    try {
      const root = await repositoryRoot(worktree)
      await ensureWorktreeDependencies(root, worktree)
    } catch {
      throw error
    }
    await runQualityGates(worktree, gates)
  }
}
