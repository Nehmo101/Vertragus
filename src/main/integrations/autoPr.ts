import { exec, execFile } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { join, posix, win32 } from 'node:path'
import { promisify } from 'node:util'
import { ensureWorktreeDependencies } from '@main/agents/dependencyBootstrap'
import type { AutoPrConfig } from '@shared/profile'
import type { RemoteCiStatus, TaskGateFinding } from '@shared/orchestrator'
import { noTaskChanges, verifiedTaskCommit } from './commitContract'
import {
  assertSecurityGate,
  evaluateSecurityGate,
  SecurityGateError
} from './securityGate'

const execFileAsync = promisify(execFile)
const execAsync = promisify(exec)
const MAX_OUTPUT = 8 * 1024 * 1024
const REMOTE_CI_REGISTRATION_TIMEOUT_MS = 90_000
const REMOTE_CI_TOTAL_TIMEOUT_MS = 20 * 60_000
const REMOTE_CI_POLL_MS = 5_000
const REMOTE_CI_READ_TIMEOUT_MS = 30_000
const REMOTE_CHECK_FIELDS = 'bucket,link,name,state,workflow'

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
  /\bENOENT\b/
]

class QualityGateError extends Error {
  readonly code = 'quality-gate-failed'
  readonly infrastructure: boolean
  constructor(readonly command: string, detail: string) {
    super(`Quality Gate fehlgeschlagen: ${command}\n${detail}`)
    this.name = 'QualityGateError'
    this.infrastructure = GATE_INFRASTRUCTURE_PATTERNS.some((pattern) => pattern.test(detail))
  }
}

/** Trailing whitespace/CRLF is fixable follow-up work, never a hard blocker. */
class CommitHygieneError extends Error {
  readonly code = 'commit-hygiene'
  constructor(readonly check: string, detail: string) {
    super(`Commit-Hygiene fehlgeschlagen (${check}): ${detail}`)
    this.name = 'CommitHygieneError'
  }
}

/**
 * Worker scratch files that must never reach a commit. Retros show workers
 * leaving *.origcheck/*.check/.verify-*-tmp.md droppings despite prompt-level
 * prohibitions — enforcement has to live in the commit path.
 */
const SCRATCH_FILE_PATTERNS = [
  /\.(?:origcheck|c9check|check|orig|rej|bak|tmp)$/i,
  /(?:^|\/)\.verify-[^/]+$/i,
  /~$/
]

export function scratchFiles(files: readonly string[]): string[] {
  return files.filter((file) => SCRATCH_FILE_PATTERNS.some((pattern) => pattern.test(file)))
}

export interface PreparedTaskChange {
  taskId: string
  title: string
  worktree: string
  branch: string
  commit: string
  commits: string[]
  files: string[]
}

export interface RemoteCiOutcome {
  status: RemoteCiStatus
  message: string
  url?: string
}

export interface RemoteCiCommandResult {
  stdout: string
  stderr: string
  exitCode: number
  timedOut: boolean
}

export interface RemoteCiCheckCommand {
  cwd: string
  prUrl: string
  watch: boolean
  timeoutMs: number
}

export interface RemoteCiMonitorDeps {
  now(): number
  delay(ms: number): Promise<void>
  runChecks(command: RemoteCiCheckCommand): Promise<RemoteCiCommandResult>
}

interface RemoteCheckRow {
  bucket: string
  link?: string
  name: string
  state?: string
  workflow?: string
}

interface MonitorRemoteCiInput {
  cwd: string
  prUrl: string
  onUpdate?: (outcome: RemoteCiOutcome) => void
}

export interface AutoPrOutcome {
  status: 'skipped' | 'prepared' | 'published' | 'blocked'
  message: string
  url?: string
  branch?: string
  worktree?: string
  remoteCi?: RemoteCiOutcome
}

interface PrepareTaskInput {
  config: AutoPrConfig
  /** Enforce the worker commit contract even when PR publishing is disabled. */
  commitOnly?: boolean
  /** HEAD captured before the worker process started. */
  baseCommit?: string
  taskId: string
  title: string
  worktree?: string
}

interface PublishInput {
  config: AutoPrConfig
  goalId: string
  goalTitle: string
  changes: PreparedTaskChange[]
  /** Profile-bound default branch when autoPr.baseBranch is empty. */
  profileDefaultBranch?: string
  onRemoteCiUpdate?: (outcome: RemoteCiOutcome) => void
}

async function runFile(cwd: string, command: string, args: string[]): Promise<string> {
  const { stdout, stderr } = await execFileAsync(command, args, {
    cwd,
    windowsHide: true,
    timeout: 120_000,
    maxBuffer: MAX_OUTPUT
  })
  return (stdout || stderr || '').trim()
}

async function runFileResult(
  cwd: string,
  command: string,
  args: string[],
  timeoutMs: number
): Promise<RemoteCiCommandResult> {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      cwd,
      windowsHide: true,
      timeout: timeoutMs,
      maxBuffer: MAX_OUTPUT
    })
    return { stdout, stderr, exitCode: 0, timedOut: false }
  } catch (error) {
    const failed = error as Error & {
      stdout?: string
      stderr?: string
      code?: number | string
      killed?: boolean
    }
    return {
      stdout: typeof failed.stdout === 'string' ? failed.stdout : '',
      stderr: typeof failed.stderr === 'string' && failed.stderr.trim() ? failed.stderr : failed.message,
      exitCode: typeof failed.code === 'number' ? failed.code : 1,
      timedOut: Boolean(failed.killed || /timed out/i.test(failed.message))
    }
  }
}

async function git(cwd: string, args: string[]): Promise<string> {
  return runFile(cwd, 'git', args)
}

/** git diff --cached --check als klassifizierbarer Hygiene-Fehler statt plain Error. */
async function assertStagedHygiene(worktree: string): Promise<void> {
  try {
    await git(worktree, ['diff', '--cached', '--check'])
  } catch (error) {
    throw new CommitHygieneError(
      'git diff --cached --check',
      error instanceof Error ? error.message : String(error)
    )
  }
}

async function stagedFileList(worktree: string): Promise<string[]> {
  return (await git(worktree, ['diff', '--cached', '--name-only']))
    .split(/\r?\n/)
    .map((file) => file.trim())
    .filter(Boolean)
}

/** Entfernt Scratch-Dateien aus dem Staging (nicht aus dem Worktree) und meldet sie. */
async function unstageScratchFiles(worktree: string): Promise<TaskGateFinding[]> {
  const scratch = scratchFiles(await stagedFileList(worktree))
  if (scratch.length === 0) return []
  await git(worktree, ['reset', '-q', 'HEAD', '--', ...scratch])
  return [{
    gate: 'commit',
    code: 'temp-files-removed',
    message: `${scratch.length} Scratch-Datei(en) wurden vor dem Commit aus dem Staging entfernt.`,
    files: scratch
  }]
}

function safeSlug(value: string, max = 42): string {
  return (
    value
      .normalize('NFKD')
      .replace(/[^a-zA-Z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .toLowerCase()
      .slice(0, max) || 'orca-task'
  )
}

function assertDiffLooksSafe(diff: string): void {
  assertSecurityGate(diff)
}

function qualityGateShellCommand(
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

function qualityGateEnvironment(
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

async function runQualityGates(
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

interface IntegrationQualityGateDeps {
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

async function runIntegrationQualityGates(
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

export type PrepareTaskResult = AutoPrOutcome & {
  result: 'disabled' | 'unavailable' | 'no-changes' | 'committed' | 'needs-work' | 'blocked'
  noChanges?: boolean
  change?: PreparedTaskChange
  findings?: TaskGateFinding[]
  /** True when the block was caused by missing gate tooling, not by the change itself. */
  infrastructure?: boolean
}

/**
 * Infrastruktur-Gate-Fehler (fehlendes eslint/prisma im frischen Worktree)
 * bekommen genau einen Bootstrap-Versuch, bevor sie als Blocker zählen.
 */
async function runGatesWithBootstrapRetry(worktree: string, gates: string[]): Promise<void> {
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

function uniqueTaskFindings(findings: TaskGateFinding[]): TaskGateFinding[] {
  return [...new Map(findings.map((finding) => [
    `${finding.gate}:${finding.code}:${(finding.files ?? []).join(',')}`,
    finding
  ])).values()]
}

function securityFindings(error: SecurityGateError): TaskGateFinding[] {
  return error.report.findings.map((finding) => ({
    gate: 'security',
    code: `missing-${finding.surface}-controls`,
    message: `${finding.surface}: ${finding.missingControls.join(', ')}`,
    files: finding.files,
    missingControls: finding.missingControls
  }))
}

async function captureNeedsWorkChange(
  input: PrepareTaskInput,
  baseCommit: string | undefined
): Promise<{ change?: PreparedTaskChange; extraFindings: TaskGateFinding[] }> {
  const status = await git(input.worktree!, ['status', '--porcelain=v1'])
  const extraFindings: TaskGateFinding[] = []
  if (status) {
    await git(input.worktree!, ['add', '--all'])
    // Kein Whitespace-Check hier: die Rettung partieller Arbeit darf nicht an
    // Trailing-Whitespace scheitern (Retro mrm3jl3a); Scratch-Dateien bleiben
    // trotzdem draußen.
    extraFindings.push(...await unstageScratchFiles(input.worktree!))
    const stagedDiff = await git(input.worktree!, ['diff', '--cached', '--no-ext-diff', '--binary'])
    const report = evaluateSecurityGate(stagedDiff, { excludePaths: input.config.securityGateExcludes })
    for (const finding of report.findings) {
      extraFindings.push({
        gate: 'security',
        code: `missing-${finding.surface}-controls`,
        message: `${finding.surface}: ${finding.missingControls.join(', ')}`,
        files: finding.files,
        missingControls: finding.missingControls
      })
    }
    const stagedFiles = (await git(input.worktree!, ['diff', '--cached', '--name-only'])).trim()
    if (stagedFiles) {
      await git(input.worktree!, [
        'commit', '-m', `orca(${input.taskId}): needs work - ${input.title.trim().slice(0, 60)}`
      ])
    }
  }

  const branch = await git(input.worktree!, ['branch', '--show-current'])
  const candidate = await git(input.worktree!, ['rev-parse', '--verify', 'HEAD^{commit}'])
  const resolved = await git(input.worktree!, ['rev-parse', '--verify', candidate + '^{commit}'])
  const commit = verifiedTaskCommit(candidate, resolved).commit
  const commits = baseCommit
    ? (await git(input.worktree!, ['rev-list', '--reverse', baseCommit + '..' + commit]))
        .split(/\r?\n/).map((value) => value.trim()).filter(Boolean)
    : [commit]
  if (commits.length === 0) return { extraFindings }
  const files = baseCommit
    ? (await git(input.worktree!, ['diff', '--name-only', baseCommit + '...' + commit]))
        .split(/\r?\n/).map((file) => file.trim()).filter(Boolean)
    : []
  return {
    extraFindings,
    change: {
      taskId: input.taskId,
      title: input.title,
      worktree: input.worktree!,
      branch,
      commit,
      commits,
      files
    }
  }
}

export async function prepareTaskChange(input: PrepareTaskInput): Promise<PrepareTaskResult> {
  if (input.config.mode === 'off' && !input.commitOnly) {
    return { status: 'skipped', result: 'disabled', message: 'Auto-PR ist deaktiviert.' }
  }
  if (!input.worktree) {
    return { status: 'blocked', result: 'unavailable', message: 'Task besitzt keinen Git-Worktree.' }
  }

  let staged = false
  let baseCommit: string | undefined
  try {
    if (input.baseCommit?.trim()) {
      const resolvedBase = await git(input.worktree, [
        'rev-parse', '--verify', input.baseCommit.trim() + '^{commit}'
      ])
      baseCommit = verifiedTaskCommit(input.baseCommit, resolvedBase).commit
    }

    const initialHeadCandidate = await git(input.worktree, ['rev-parse', '--verify', 'HEAD^{commit}'])
    const initialHeadResolved = await git(input.worktree, [
      'rev-parse', '--verify', initialHeadCandidate + '^{commit}'
    ])
    const initialHead = verifiedTaskCommit(initialHeadCandidate, initialHeadResolved).commit

    // A worker may have ignored the no-Git contract. Preserve its file result,
    // but rewrite every worker-authored commit into one centrally owned commit.
    if (baseCommit && initialHead !== baseCommit) {
      await git(input.worktree, ['reset', '--soft', baseCommit])
      staged = true
    }
    const initialStatus = await git(input.worktree, ['status', '--porcelain=v1'])
    if (!initialStatus) {
      return { status: 'skipped', message: 'Keine Änderungen; expliziter No-op bestätigt.', ...noTaskChanges() }
    }
    const hygieneFindings: TaskGateFinding[] = []
    if (initialStatus) {
      await git(input.worktree, ['add', '--all'])
      staged = true
      hygieneFindings.push(...await unstageScratchFiles(input.worktree))
      await assertStagedHygiene(input.worktree)
      assertSecurityGate(
        await git(input.worktree, ['diff', '--cached', '--no-ext-diff', '--binary']),
        { excludePaths: input.config.securityGateExcludes }
      )
    }

    await runGatesWithBootstrapRetry(input.worktree, input.config.qualityGates)

    // Gates may format or generate files. Stage and inspect their final output too.
    await git(input.worktree, ['add', '--all'])
    staged = true
    hygieneFindings.push(...await unstageScratchFiles(input.worktree))
    await assertStagedHygiene(input.worktree)
    const stagedDiff = await git(input.worktree, ['diff', '--cached', '--no-ext-diff', '--binary'])
    if (stagedDiff) {
      assertSecurityGate(stagedDiff, { excludePaths: input.config.securityGateExcludes })
    }
    const stagedFiles = await stagedFileList(input.worktree)

    if (stagedFiles.length > 0) {
      await git(input.worktree, [
        'commit', '-m', 'orca(' + input.taskId + '): ' + input.title.trim().slice(0, 72)
      ])
    }
    const branch = await git(input.worktree, ['branch', '--show-current'])
    if (!branch.trim()) throw new Error('Commit-Vertrag verletzt: Worker-Branch ist nicht bestimmbar.')
    const candidate = await git(input.worktree, ['rev-parse', '--verify', 'HEAD^{commit}'])
    const resolved = await git(input.worktree, ['rev-parse', '--verify', candidate + '^{commit}'])
    const contract = verifiedTaskCommit(candidate, resolved)
    const commitLines = baseCommit
      ? (await git(input.worktree, ['rev-list', '--reverse', baseCommit + '..' + contract.commit]))
          .split(/\r?\n/).map((value) => value.trim()).filter(Boolean)
      : [contract.commit]
    const commits: string[] = []
    for (const value of commitLines) {
      const verified = await git(input.worktree, ['rev-parse', '--verify', value + '^{commit}'])
      commits.push(verifiedTaskCommit(value, verified).commit)
    }
    if (commits.length === 0) {
      return { status: 'skipped', message: 'Keine versionierbaren Änderungen; No-op bestätigt.', ...noTaskChanges() }
    }
    const files = baseCommit
      ? (await git(input.worktree, ['diff', '--name-only', baseCommit + '...' + contract.commit]))
          .split(/\r?\n/).map((file) => file.trim()).filter(Boolean)
      : stagedFiles
    const change: PreparedTaskChange = {
      taskId: input.taskId,
      title: input.title,
      worktree: input.worktree,
      branch,
      commit: contract.commit,
      commits,
      files
    }
    return {
      status: 'prepared',
      result: 'committed',
      noChanges: false,
      message: files.length + ' Datei(en) in ' + commits.length + ' Commit(s) verifiziert.',
      branch,
      worktree: input.worktree,
      change,
      findings: hygieneFindings.length > 0 ? uniqueTaskFindings(hygieneFindings) : undefined
    }
  } catch (error) {
    if (error instanceof QualityGateError && error.infrastructure) {
      // Fehlendes Tooling ist kein Befund gegen die Änderung: kein needs-work,
      // sondern ein als Infrastruktur klassifizierter Blocker für den Retry-Pfad.
      if (staged) {
        try {
          await git(input.worktree, ['reset', '--mixed', 'HEAD'])
        } catch {
          // Preserve the original error and surface the worktree path below.
        }
      }
      return {
        status: 'blocked',
        result: 'blocked',
        infrastructure: true,
        message: `Gate-Infrastruktur fehlgeschlagen: ${error.message}`,
        worktree: input.worktree
      }
    }
    if (
      error instanceof SecurityGateError ||
      error instanceof QualityGateError ||
      error instanceof CommitHygieneError
    ) {
      try {
        const captured = await captureNeedsWorkChange(input, baseCommit)
        if (captured.change) {
          const findings = uniqueTaskFindings(error instanceof SecurityGateError
            ? [...securityFindings(error), ...captured.extraFindings]
            : error instanceof CommitHygieneError
              ? [{
                  gate: 'commit' as const,
                  code: 'whitespace',
                  message: error.message
                }, ...captured.extraFindings]
              : [{
                  gate: 'quality' as const,
                  code: error.code,
                  message: error.message
                }, ...captured.extraFindings])
          return {
            status: 'blocked',
            result: 'needs-work',
            message: `Partieller Commit ${captured.change.commit.slice(0, 8)} bleibt erhalten; Gates benötigen Nacharbeit.`,
            branch: captured.change.branch,
            worktree: input.worktree,
            change: captured.change,
            findings
          }
        }
      } catch (captureError) {
        const detail = captureError instanceof Error ? captureError.message : String(captureError)
        return {
          status: 'blocked',
          result: 'blocked',
          message: `${error.message}\nPartielle Arbeit konnte nicht zentral gesichert werden: ${detail}`,
          worktree: input.worktree
        }
      }
    }
    if (staged) {
      try {
        await git(input.worktree, ['reset', '--mixed', 'HEAD'])
      } catch {
        // Preserve the original error and surface the worktree path below.
      }
    }
    return {
      status: 'blocked',
      result: 'blocked',
      message: error instanceof Error ? error.message : String(error),
      worktree: input.worktree
    }
  }
}

async function repositoryRoot(cwd: string): Promise<string> {
  const porcelain = await git(cwd, ['worktree', 'list', '--porcelain'])
  const first = porcelain.match(/^worktree\s+(.+)$/m)?.[1]
  if (!first) throw new Error('Repository-Hauptworktree konnte nicht bestimmt werden.')
  return first.trim()
}

export function pickBaseBranch(
  configured: string,
  profileDefaultBranch?: string,
  remoteBranch?: string
): string {
  if (configured.trim()) return configured.trim()
  if (profileDefaultBranch?.trim()) return profileDefaultBranch.trim()
  if (remoteBranch?.trim()) return remoteBranch.trim()
  return 'main'
}

async function defaultBase(
  cwd: string,
  configured: string,
  profileDefaultBranch?: string
): Promise<string> {
  if (configured.trim()) return configured.trim()
  if (profileDefaultBranch?.trim()) return profileDefaultBranch.trim()
  try {
    const symbolic = await git(cwd, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])
    return symbolic.replace(/^origin\//, '')
  } catch {
    return 'main'
  }
}

async function findExistingPr(cwd: string, branch: string): Promise<string | undefined> {
  const raw = await runFile(cwd, 'gh', [
    'pr',
    'list',
    '--head',
    branch,
    '--state',
    'all',
    '--json',
    'url',
    '--limit',
    '1'
  ])
  const rows = JSON.parse(raw || '[]') as Array<{ url?: string }>
  return rows[0]?.url
}

async function pushAndOpenPr(
  cwd: string,
  config: AutoPrConfig,
  branch: string,
  title: string,
  body: string,
  profileDefaultBranch?: string
): Promise<string> {
  if (['main', 'master'].includes(branch.toLowerCase())) {
    throw new Error(`Auto-PR verweigert Push auf geschützten Branch ${branch}.`)
  }
  await runFile(cwd, 'gh', ['auth', 'status'])
  await git(cwd, ['push', '--set-upstream', 'origin', branch])
  const existing = await findExistingPr(cwd, branch)
  if (existing) return existing

  const args = ['pr', 'create', '--head', branch, '--title', title, '--body', body]
  const base = await defaultBase(cwd, config.baseBranch, profileDefaultBranch)
  if (base) args.push('--base', base)
  if (config.mode === 'draft-after-checks') args.push('--draft')
  for (const label of config.labels) args.push('--label', label)
  for (const reviewer of config.reviewers) args.push('--reviewer', reviewer)
  return runFile(cwd, 'gh', args)
}

function parseRemoteChecks(raw: string): RemoteCheckRow[] {
  if (!raw.trim()) return []
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter((row): row is RemoteCheckRow => {
      if (!row || typeof row !== 'object') return false
      const candidate = row as Partial<RemoteCheckRow>
      return typeof candidate.bucket === 'string' && typeof candidate.name === 'string'
    })
  } catch {
    return []
  }
}

function remoteCiFromChecks(checks: RemoteCheckRow[], prUrl: string): RemoteCiOutcome {
  const failed = checks.find((check) => check.bucket === 'fail')
  if (failed) {
    return {
      status: 'failed',
      message: `Remote-CI fehlgeschlagen: ${failed.workflow || failed.name}.`,
      url: failed.link || prUrl
    }
  }
  const cancelled = checks.find((check) => check.bucket === 'cancel')
  if (cancelled) {
    return {
      status: 'cancelled',
      message: `Remote-CI abgebrochen: ${cancelled.workflow || cancelled.name}.`,
      url: cancelled.link || prUrl
    }
  }
  const pending = checks.filter((check) => !['pass', 'skipping'].includes(check.bucket))
  if (pending.length > 0) {
    return {
      status: 'pending',
      message: `${pending.length} Remote-Check(s) laufen.`,
      url: pending[0]?.link || prUrl
    }
  }
  return {
    status: 'passed',
    message: `${checks.length} Remote-Check(s) grün.`,
    url: checks[0]?.link || prUrl
  }
}

function combineRemoteCi(outcomes: RemoteCiOutcome[]): RemoteCiOutcome {
  if (outcomes.length === 0) {
    return { status: 'waiting', message: 'Remote-CI wird registriert.' }
  }
  if (outcomes.length === 1) return outcomes[0]
  const priority: Record<RemoteCiStatus, number> = {
    failed: 7,
    cancelled: 6,
    unavailable: 5,
    'timed-out': 4,
    pending: 3,
    waiting: 2,
    passed: 1
  }
  const decisive = outcomes.reduce((current, outcome) =>
    priority[outcome.status] > priority[current.status] ? outcome : current
  )
  const counts = new Map<RemoteCiStatus, number>()
  for (const outcome of outcomes) counts.set(outcome.status, (counts.get(outcome.status) ?? 0) + 1)
  return {
    status: decisive.status,
    message: `Remote-CI (${outcomes.length} PRs): ${[...counts.entries()]
      .map(([status, count]) => `${count} ${status}`)
      .join(', ')}.`,
    url: decisive.url
  }
}

function hasAuthFailure(result: RemoteCiCommandResult): boolean {
  return /(auth|login|logged in|token|HTTP 40[13]|permission)/i.test(
    result.stdout + '\n' + result.stderr
  )
}

function isNoChecksYet(result: RemoteCiCommandResult): boolean {
  return /no checks reported/i.test(result.stdout + '\n' + result.stderr)
}

function commandDetail(result: RemoteCiCommandResult): string {
  return (result.stderr || result.stdout).replace(/\s+/g, ' ').trim().slice(0, 240)
}

const defaultRemoteCiDeps: RemoteCiMonitorDeps = {
  now: () => Date.now(),
  delay: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  runChecks: async (command) => {
    const args = ['pr', 'checks', command.prUrl, '--json', REMOTE_CHECK_FIELDS]
    if (command.watch) args.push('--watch', '--fail-fast', '--interval', '10')
    return runFileResult(command.cwd, 'gh', args, command.timeoutMs)
  }
}

async function monitorRemoteCi(
  input: MonitorRemoteCiInput,
  deps: RemoteCiMonitorDeps = defaultRemoteCiDeps
): Promise<RemoteCiOutcome> {
  const startedAt = deps.now()
  const report = (outcome: RemoteCiOutcome): RemoteCiOutcome => {
    input.onUpdate?.(outcome)
    return outcome
  }

  report({ status: 'waiting', message: 'Remote-CI wird registriert.', url: input.prUrl })

  while (deps.now() - startedAt <= REMOTE_CI_REGISTRATION_TIMEOUT_MS) {
    const currentResult = await deps.runChecks({
      cwd: input.cwd,
      prUrl: input.prUrl,
      watch: false,
      timeoutMs: REMOTE_CI_READ_TIMEOUT_MS
    })
    if (hasAuthFailure(currentResult)) {
      return report({
        status: 'unavailable',
        message: 'Remote-CI nicht verfügbar: GitHub-Authentifizierung fehlt oder ist ungültig.',
        url: input.prUrl
      })
    }

    const checks = parseRemoteChecks(currentResult.stdout)
    if (checks.length > 0) {
      const current = remoteCiFromChecks(checks, input.prUrl)
      report(current)
      if (current.status !== 'pending') return current

      const remaining = REMOTE_CI_TOTAL_TIMEOUT_MS - (deps.now() - startedAt)
      if (remaining <= 0) {
        return report({
          status: 'timed-out',
          message: 'Remote-CI läuft nach dem Zeitlimit weiter.',
          url: current.url || input.prUrl
        })
      }

      const watched = await deps.runChecks({
        cwd: input.cwd,
        prUrl: input.prUrl,
        watch: true,
        timeoutMs: remaining
      })
      if (hasAuthFailure(watched)) {
        return report({
          status: 'unavailable',
          message: 'Remote-CI nicht verfügbar: GitHub-Authentifizierung ist abgelaufen.',
          url: input.prUrl
        })
      }
      if (watched.timedOut) {
        return report({
          status: 'timed-out',
          message: 'Remote-CI läuft nach dem Zeitlimit weiter.',
          url: current.url || input.prUrl
        })
      }

      const finalResult = await deps.runChecks({
        cwd: input.cwd,
        prUrl: input.prUrl,
        watch: false,
        timeoutMs: REMOTE_CI_READ_TIMEOUT_MS
      })
      if (hasAuthFailure(finalResult)) {
        return report({
          status: 'unavailable',
          message: 'Remote-CI-Ergebnis konnte wegen GitHub-Authentifizierung nicht gelesen werden.',
          url: input.prUrl
        })
      }
      const finalChecks = parseRemoteChecks(finalResult.stdout)
      if (finalChecks.length > 0) {
        const finalOutcome = remoteCiFromChecks(finalChecks, input.prUrl)
        if (finalOutcome.status !== 'pending') return report(finalOutcome)
      }
      return report({
        status: 'timed-out',
        message: 'Remote-CI-Watch endete ohne terminales Ergebnis.',
        url: current.url || input.prUrl
      })
    }

    if (
      currentResult.exitCode !== 0 &&
      currentResult.exitCode !== 8 &&
      !currentResult.timedOut &&
      !isNoChecksYet(currentResult)
    ) {
      return report({
        status: 'unavailable',
        message: `Remote-CI konnte nicht gelesen werden: ${commandDetail(currentResult) || 'unbekannter gh-Fehler'}.`,
        url: input.prUrl
      })
    }
    await deps.delay(REMOTE_CI_POLL_MS)
  }

  return report({
    status: 'timed-out',
    message: 'GitHub hat innerhalb von 90 Sekunden keine Remote-Checks registriert.',
    url: input.prUrl
  })
}

async function publishPerTask(input: PublishInput): Promise<AutoPrOutcome> {
  const published: Array<{ cwd: string; url: string }> = []
  for (const change of input.changes) {
    const body = [
      `Automatisch vorbereitet von Vertragus für **${input.goalTitle}**.`,
      '',
      `Task: ${change.taskId} – ${change.title}`,
      '',
      'Quality Gates:',
      ...input.config.qualityGates.map((gate) => `- \`${gate}\``),
      '- Security Gate (Secrets + sensitive negative tests)'
    ].join('\n')
    const url = await pushAndOpenPr(
      change.worktree,
      input.config,
      change.branch,
      `[Orca ${change.taskId}] ${change.title}`,
      body,
      input.profileDefaultBranch
    )
    published.push({ cwd: change.worktree, url })
  }

  const live = new Map<number, RemoteCiOutcome>()
  const remoteOutcomes = await Promise.all(
    published.map((entry, index) =>
      monitorRemoteCi({
        cwd: entry.cwd,
        prUrl: entry.url,
        onUpdate: (outcome) => {
          live.set(index, outcome)
          input.onRemoteCiUpdate?.(combineRemoteCi([...live.values()]))
        }
      })
    )
  )
  const remoteCi = combineRemoteCi(remoteOutcomes)
  input.onRemoteCiUpdate?.(remoteCi)
  return {
    status: 'published',
    message: `${published.length} Pull Request(s) erstellt oder wiederverwendet. ${remoteCi.message}`,
    url: published[0]?.url,
    remoteCi
  }
}

async function publishAggregate(input: PublishInput): Promise<AutoPrOutcome> {
  const first = input.changes[0]
  const root = await repositoryRoot(first.worktree)
  const branch = `orca/goal-${safeSlug(input.goalId)}-${Date.now().toString(36)}`
  const integrationPath = join(root, '.orca-worktrees', 'integration', safeSlug(branch, 60))
  await mkdir(join(root, '.orca-worktrees', 'integration'), { recursive: true })
  const base = await defaultBase(root, input.config.baseBranch, input.profileDefaultBranch)
  await git(root, ['worktree', 'add', '-b', branch, integrationPath, `origin/${base}`])

  try {
    for (const change of input.changes) {
      for (const commit of change.commits) {
        const candidate = await git(change.worktree, ['rev-parse', '--verify', commit + '^{commit}'])
        const contract = verifiedTaskCommit(commit, candidate)
        await git(integrationPath, ['cherry-pick', contract.commit])
      }
    }
    const integratedDiff = await git(integrationPath, ['diff', '--no-ext-diff', '--binary', `origin/${base}...HEAD`])
    assertSecurityGate(integratedDiff, { excludePaths: input.config.securityGateExcludes })
    await runIntegrationQualityGates(root, integrationPath, input.config.qualityGates)
    const body = [
      `Automatisch integriert von Vertragus für **${input.goalTitle}**.`,
      '',
      'Enthaltene Tasks:',
      ...input.changes.map((change) => `- ${change.taskId}: ${change.title}`),
      '',
      'Quality Gates:',
      ...input.config.qualityGates.map((gate) => `- \`${gate}\``),
      '- Security Gate (Secrets + sensitive negative tests)'
    ].join('\n')
    const url = await pushAndOpenPr(
      integrationPath,
      input.config,
      branch,
      `[Orca] ${input.goalTitle}`,
      body,
      input.profileDefaultBranch
    )
    const remoteCi = await monitorRemoteCi({
      cwd: integrationPath,
      prUrl: url,
      onUpdate: input.onRemoteCiUpdate
    })
    return {
      status: 'published',
      message: `${input.changes.length} Tasks in einen Pull Request integriert. ${remoteCi.message}`,
      url,
      branch,
      worktree: integrationPath,
      remoteCi
    }
  } catch (error) {
    try {
      await git(integrationPath, ['cherry-pick', '--abort'])
    } catch {
      // Keep the integration worktree for manual conflict inspection.
    }
    return {
      status: 'blocked',
      message: error instanceof Error ? error.message : String(error),
      branch,
      worktree: integrationPath
    }
  }
}

export async function publishPreparedChanges(input: PublishInput): Promise<AutoPrOutcome> {
  if (input.config.mode === 'off') return { status: 'skipped', message: 'Auto-PR ist deaktiviert.' }
  if (input.changes.length === 0) return { status: 'skipped', message: 'Keine Task-Commits vorhanden.' }
  try {
    return input.config.strategy === 'per-task'
      ? await publishPerTask(input)
      : await publishAggregate(input)
  } catch (error) {
    return { status: 'blocked', message: error instanceof Error ? error.message : String(error) }
  }
}

export const autoPrInternals = {
  safeSlug,
  assertDiffLooksSafe,
  qualityGateEnvironment,
  runQualityGates,
  defaultBase,
  pickBaseBranch,
  parseRemoteChecks,
  remoteCiFromChecks,
  combineRemoteCi,
  monitorRemoteCi,
  qualityGateShellCommand,
  runIntegrationQualityGates
}
