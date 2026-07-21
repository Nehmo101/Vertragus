import { join, posix, win32 } from 'node:path'
import { ensureWorktreeDependencies } from '@main/agents/dependencyBootstrap'
import { assertSecurityGate } from '../securityGate'
import { execAsync, MAX_OUTPUT, repositoryRoot } from './gitPlumbing'

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
  const integrationRoot = pathApi.resolve(repositoryRoot, '.orca-worktrees', 'integration')
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
