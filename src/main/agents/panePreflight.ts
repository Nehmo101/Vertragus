import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { access, mkdir, mkdtemp, open, rm, rmdir } from 'node:fs/promises'
import { constants } from 'node:fs'
import { tmpdir } from 'node:os'
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
import { resolveFaithfulShimLaunch, resolveLaunch } from '@main/agents/resolveCommand'
import {
  CODEX_RUNTIME_DIR_NAME,
  codexSingleRootEnvironment,
  codexSingleRootSandboxArgs
} from '@main/agents/codexSandbox'

const execFileAsync = promisify(execFile)
const PREFLIGHT_TIMEOUT_MS = 12_000
const CANARY_DIAGNOSTIC_LIMIT = 2_000

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
  const path = join(directory, `.vertragus-preflight-${randomUUID()}.tmp`)
  const handle = await open(path, 'wx', 0o600)
  try {
    await handle.writeFile('vertragus-preflight\n', 'utf8')
  } finally {
    await handle.close()
    await rm(path, { force: true })
  }
}

/**
 * Exercise Codex's real Windows sandbox bootstrap without a model call. A
 * host-process write probe alone cannot detect restricted-token or
 * split-writable-root failures that only happen in a nested Codex process.
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
    "$path = $env:VERTRAGUS_CODEX_CANARY_PATH; [System.IO.File]::WriteAllText($path, 'vertragus-runtime-preflight'); Remove-Item -LiteralPath $path -Force"
  ]
}

async function canonicalPreflightPaths(input: PanePreflightInput): Promise<{
  profileWorkspace: string
  workerWorkspace?: string
}> {
  const profileWorkspace = await canonicalWorkspacePath(input.workingDir)
  const workerWorkspace = input.worktree
    ? await canonicalWorkspacePath(input.worktree)
    : undefined
  return { profileWorkspace, workerWorkspace }
}

function canaryFailure(error: unknown, workingDir: string): Error {
  const failure = error as {
    message?: unknown
    stderr?: unknown
    killed?: unknown
    code?: unknown
  }
  const timedOut = failure.killed === true || failure.code === 'ETIMEDOUT'
  const reason = timedOut
    ? `Timeout nach ${PREFLIGHT_TIMEOUT_MS} ms`
    : typeof failure.message === 'string'
      ? failure.message
      : String(error)
  const stderr =
    typeof failure.stderr === 'string' || Buffer.isBuffer(failure.stderr)
      ? String(failure.stderr).trim().slice(0, CANARY_DIAGNOSTIC_LIMIT)
      : ''
  return new Error(
    `Codex-Sandbox-Canary fehlgeschlagen in ${workingDir}: ${reason}${stderr ? `; stderr: ${stderr}` : ''}`
  )
}

type RuntimeCanaryResult = { status?: PanePreflightCheck['status']; detail: string }

/**
 * Injectable seams for the Cursor transport canary so the positive/negative
 * cases (including the historical cmd.exe truncation) are testable without a
 * real Cursor install or a paid model call.
 */
export interface CursorCanaryDeps {
  /** Launch cursor-agent --version through the faithful (non-shell) path; returns the first version line. Throws when no argument-faithful entrypoint exists. */
  probeVersion: () => Promise<string>
  /** Send a multiline fingerprint through exactly the worker's argument transport and return what the target process received. */
  transportRoundtrip: (fingerprint: string) => Promise<string>
}

/** First non-empty line of a CLI's stdout/stderr. */
function firstLine(text: string): string {
  return text.split(/\r?\n/).find(Boolean)?.trim() ?? ''
}

function defaultCursorCanaryDeps(): CursorCanaryDeps {
  return {
    async probeVersion() {
      // Empty, controlled working directory — never the repository.
      const dir = await mkdtemp(join(tmpdir(), 'vertragus-cursor-version-'))
      try {
        // requireFaithfulArgs throws instead of returning a cmd.exe wrapper, so
        // a Cursor install that can only be reached through a truncating shell
        // fails the canary here instead of silently shipping broken prompts.
        const launch = await resolveLaunch('cursor-agent', ['--version'], {
          requireFaithfulArgs: true
        })
        const { stdout, stderr } = await execFileAsync(launch.file, launch.args, {
          cwd: dir,
          windowsHide: true,
          timeout: PREFLIGHT_TIMEOUT_MS
        })
        return firstLine(stdout || stderr) || 'startet'
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    },
    async transportRoundtrip(fingerprint) {
      // Reproduce the exact worker transport: a Windows script shim rewritten to
      // a direct Node entrypoint, then spawned without a shell. The echo target
      // prints back the positional argument it actually received.
      const dir = await mkdtemp(join(tmpdir(), 'vertragus-cursor-transport-'))
      try {
        await open(join(dir, 'vertragus-echo.mjs'), 'w', 0o600).then(async (handle) => {
          await handle.writeFile('process.stdout.write(process.argv[2] ?? "")', 'utf8')
          await handle.close()
        })
        const shim = join(dir, 'cursor-agent.cmd')
        await open(shim, 'w', 0o600).then(async (handle) => {
          await handle.writeFile(
            '@ECHO off\r\nSETLOCAL\r\n"%~dp0\\node.exe"  "%~dp0\\vertragus-echo.mjs" %*\r\n',
            'utf8'
          )
          await handle.close()
        })
        const launch = await resolveFaithfulShimLaunch(shim, [fingerprint])
        if (!launch) {
          throw new Error('Shim liess sich nicht auf einen argumenttreuen Entrypoint aufloesen.')
        }
        const { stdout } = await execFileAsync(launch.file, launch.args, {
          cwd: dir,
          windowsHide: true,
          timeout: PREFLIGHT_TIMEOUT_MS,
          maxBuffer: 1024 * 1024,
          // The resolved interpreter may be the Electron binary when no standalone
          // node is on PATH; run it as plain Node so the echo cannot spuriously
          // fail the transport canary.
          env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
        })
        return stdout
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    }
  }
}

async function runCursorRuntimeCanary(deps: CursorCanaryDeps): Promise<RuntimeCanaryResult> {
  let version: string
  try {
    version = await deps.probeVersion()
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    return {
      status: 'failed',
      detail:
        'Cursor-Preflight: kein argumenttreuer Startpfad fuer cursor-agent verifizierbar ' +
        `(${detail}). Ein cmd.exe/PowerShell-Wrapper wuerde mehrzeilige Prompts abschneiden.`
    }
  }

  // Two distinct lines separated by a blank line — the exact shape whose second
  // half was lost in the real multiagent run (only ["IDENTITY"] arrived).
  const identity = 'VERTRAGUS-CURSOR-CANARY-IDENTITAET'
  const fingerprint = 'VERTRAGUS-CURSOR-CANARY-FINGERPRINT'
  const probe = `${identity}\n\n${fingerprint}`
  let received: string
  try {
    received = await deps.transportRoundtrip(probe)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    return { status: 'failed', detail: `Cursor-Argumenttransport nicht verifizierbar: ${detail}` }
  }

  if (!received.includes(fingerprint)) {
    return {
      status: 'failed',
      detail:
        `Cursor-Argumenttransport gekuerzt: nur "${firstLine(received)}" statt der vollstaendigen ` +
        `mehrzeiligen Eingabe angekommen — der Fingerprint hinter dem Zeilenumbruch fehlt ` +
        '(cmd.exe-Truncation-Regression, exakt der reale Multiagent-Fehler).'
    }
  }
  if (received !== probe) {
    return {
      status: 'failed',
      detail:
        `Cursor-Argumenttransport verfaelscht: empfangen ${JSON.stringify(received)}, ` +
        `erwartet ${JSON.stringify(probe)}.`
    }
  }

  return {
    detail:
      `Cursor-Version: ${version}. Argumenttransport verifiziert — mehrzeiliger Fingerprint ` +
      `(${Buffer.byteLength(probe)} Bytes, ${probe.split('\n').length} Zeilen) kommt byte-treu an. ` +
      'Kein Modell-Roundtrip ausgefuehrt (deterministischer Transport-Canary).'
  }
}

/**
 * A model-free Cursor canary is deterministic per (provider, installed version,
 * platform, app session): the installed CLI and the transport code do not change
 * within one app process. Cache the in-flight promise so five concurrent
 * candidates share one preparation instead of repeating it; evict on an
 * unexpected rejection so a transient error never poisons the session.
 */
const cursorCanaryCache = new Map<string, Promise<RuntimeCanaryResult>>()

function cursorRuntimeCanary(
  platform: NodeJS.Platform,
  deps: CursorCanaryDeps = defaultCursorCanaryDeps()
): Promise<RuntimeCanaryResult> {
  const key = `cursor:${platform}`
  let pending = cursorCanaryCache.get(key)
  if (!pending) {
    pending = runCursorRuntimeCanary(deps)
    cursorCanaryCache.set(key, pending)
    void pending.catch(() => cursorCanaryCache.delete(key))
  }
  return pending
}

async function providerRuntimeCanary(
  input: PanePreflightInput,
  profileWorkspace: string,
  workerWorkspace?: string,
  platform: NodeJS.Platform = process.platform
): Promise<{
  status?: PanePreflightCheck['status']
  detail: string
}> {
  if (input.provider === 'cursor') {
    return cursorRuntimeCanary(platform)
  }
  if (input.provider !== 'codex') {
    return { detail: 'Fuer diesen Provider ist kein separater Runtime-Canary erforderlich.' }
  }
  if (input.yolo) {
    return {
      status: 'warning',
      detail: 'Expliziter Yolo-Modus: Codex umgeht Approval- und Sandbox-Pruefungen.'
    }
  }
  if (platform !== 'win32') {
    return {
      status: 'warning',
      detail: 'Der Codex-Runtime-Canary ist derzeit auf den Windows-Sandboxfehler zugeschnitten.'
    }
  }

  const runtimeRoot = join(workerWorkspace ?? profileWorkspace, CODEX_RUNTIME_DIR_NAME)
  await mkdir(runtimeRoot, { recursive: true })
  let canaryWorkspace = workerWorkspace
  let poolWorkspace: string | undefined
  let markerPath: string | undefined
  let runtimeDir: string | undefined
  try {
    if (!canaryWorkspace) {
      poolWorkspace = await mkdtemp(join(runtimeRoot, 'preflight-workspace-'))
      canaryWorkspace = poolWorkspace
    }
    markerPath = join(canaryWorkspace, `.vertragus-codex-runtime-${randomUUID()}.tmp`)
    runtimeDir = await mkdtemp(
      join(workerWorkspace ? runtimeRoot : canaryWorkspace, 'preflight-runtime-')
    )
    const launch = await resolveLaunch('codex', codexRuntimeCanaryArgs(canaryWorkspace))
    try {
      await execFileAsync(launch.file, launch.args, {
        cwd: canaryWorkspace,
        env: codexSingleRootEnvironment(runtimeDir, {
          ...process.env,
          VERTRAGUS_CODEX_CANARY_PATH: markerPath
        }, platform),
        windowsHide: true,
        timeout: PREFLIGHT_TIMEOUT_MS
      })
    } catch (error) {
      throw canaryFailure(error, canaryWorkspace)
    }
  } finally {
    if (markerPath) await rm(markerPath, { force: true })
    if (runtimeDir) await rm(runtimeDir, { recursive: true, force: true })
    if (poolWorkspace) await rm(poolWorkspace, { recursive: true, force: true })
    await rmdir(runtimeRoot).catch(() => undefined)
  }
  return {
    detail: workerWorkspace
      ? `Codex-Sandbox startet und schreibt im Worker-Worktree: ${workerWorkspace}`
      : `Codex-Sandbox startet und schreibt im isolierten Pool-Arbeitsverzeichnis: ${canaryWorkspace}`
  }
}

export async function runPanePreflight(input: PanePreflightInput): Promise<PanePreflightReport> {
  const startedAt = Date.now()
  const { profileWorkspace: canonicalWorkspace, workerWorkspace: canonicalWorker } =
    await canonicalPreflightPaths(input)
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
    check('provider-runtime', () =>
      providerRuntimeCanary(input, canonicalWorkspace, canonicalWorker)
    ),
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

export const panePreflightInternals = {
  canonicalPreflightPaths,
  providerRuntimeCanary,
  cursorRuntimeCanary,
  resetCursorCanaryCache: (): void => cursorCanaryCache.clear()
}
