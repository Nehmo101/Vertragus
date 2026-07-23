/**
 * Optional second secret scanner for the Auto-PR gate chain: runs a locally
 * installed gitleaks binary against the STAGED changes of a task worktree.
 *
 * gitleaks is executed via execFile and never through a shell. The staged-scan
 * syntax depends on the installed version: v8.19 restructured the CLI and
 * replaced `gitleaks protect --staged` with `gitleaks git --staged`, so a
 * version probe (`gitleaks version`) picks the correct command. Findings are
 * read from the JSON report file; only Description/File/StartLine/RuleID are
 * ever copied out of the report — the Secret and Match fields are never
 * touched, and every scan additionally runs with --redact as defense in depth.
 */
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export interface GitleaksFinding {
  file: string
  line: number
  rule: string
  /** Human-readable rule description from the report — never the secret itself. */
  redactedMatch: string
}

export type GitleaksScanResult =
  | { status: 'clean' }
  | { status: 'findings'; findings: GitleaksFinding[] }
  /** The gitleaks binary is not installed (spawn ENOENT). */
  | { status: 'unavailable' }
  /** gitleaks timed out, crashed, or produced an unusable report. */
  | { status: 'error'; message: string }

const PROBE_TIMEOUT_MS = 10_000
const SCAN_TIMEOUT_MS = 60_000
const MAX_OUTPUT = 4 * 1024 * 1024
/** Upper bound so a pathological report cannot flood the gate finding text. */
const MAX_FINDINGS = 50

export interface GitleaksVersion {
  major: number
  minor: number
}

/** Accepts `8.18.4`, `v8.20.1`, or a full `gitleaks version 8.x.y` banner line. */
export function parseGitleaksVersion(output: string): GitleaksVersion | undefined {
  const match = /(\d+)\.(\d+)(?:\.\d+)?/.exec(output)
  if (!match) return undefined
  return { major: Number(match[1]), minor: Number(match[2]) }
}

/**
 * v8.19+ scans staged changes via `gitleaks git --staged`; older v8 releases
 * use the `protect` command that v8.19 removed. An unparseable version is
 * treated as modern — `protect` has been gone for years.
 */
export function stagedScanArgs(version: GitleaksVersion | undefined, reportPath: string): string[] {
  const modern = !version || version.major > 8 || (version.major === 8 && version.minor >= 19)
  return [
    modern ? 'git' : 'protect',
    '--staged',
    '--no-banner',
    '--redact',
    '--report-format', 'json',
    '--report-path', reportPath
  ]
}

interface ExecOutcome {
  error: (Error & {
    code?: string | number | null
    killed?: boolean
    signal?: NodeJS.Signals | null
  }) | null
  stdout: string
  stderr: string
}

/**
 * Runs the gitleaks binary via execFile (argument vector, no shell). Resolves
 * instead of rejecting so the caller can classify exit codes and spawn errors.
 */
function runGitleaks(cwd: string, args: string[], timeout: number): Promise<ExecOutcome> {
  return new Promise((resolve) => {
    execFile(
      'gitleaks',
      args,
      { cwd, windowsHide: true, shell: false, timeout, maxBuffer: MAX_OUTPUT },
      (error, stdout, stderr) => {
        resolve({
          error: error as ExecOutcome['error'],
          stdout: typeof stdout === 'string' ? stdout : String(stdout ?? ''),
          stderr: typeof stderr === 'string' ? stderr : String(stderr ?? '')
        })
      }
    )
  })
}

/** Collapse whitespace and bound the length of process output used in messages. */
function trimSnippet(value: string, max = 400): string {
  const flat = value.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

/**
 * Parses a gitleaks JSON report (array of findings). Only the documented
 * Description/File/StartLine/RuleID fields are read; the Secret and Match
 * fields never leave the report, no matter what the file contains.
 */
export function parseGitleaksReport(raw: string): GitleaksScanResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { status: 'error', message: 'gitleaks-Report ist kein gültiges JSON.' }
  }
  if (!Array.isArray(parsed)) {
    return { status: 'error', message: 'gitleaks-Report hat ein unerwartetes Format (JSON-Array erwartet).' }
  }
  if (parsed.length === 0) return { status: 'clean' }
  const findings = parsed.slice(0, MAX_FINDINGS).map((entry): GitleaksFinding => {
    const record = (typeof entry === 'object' && entry !== null ? entry : {}) as Record<string, unknown>
    return {
      file: typeof record.File === 'string' && record.File ? record.File : '<unbekannte Datei>',
      line:
        typeof record.StartLine === 'number' && Number.isFinite(record.StartLine)
          ? record.StartLine
          : 0,
      rule: typeof record.RuleID === 'string' && record.RuleID ? record.RuleID : 'unbekannte-regel',
      redactedMatch:
        typeof record.Description === 'string' && record.Description ? record.Description : 'REDACTED'
    }
  })
  return { status: 'findings', findings }
}

/** German gate finding text: file/line/rule/description only, never secret material. */
export function formatGitleaksFindings(findings: readonly GitleaksFinding[]): string {
  const lines = findings.map(
    (finding) => `- ${finding.file}:${finding.line} [${finding.rule}] ${finding.redactedMatch}`
  )
  return [
    `gitleaks hat ${findings.length} potenzielle(s) Secret(s) im Staging gefunden:`,
    ...lines
  ].join('\n')
}

async function readReport(reportPath: string, stderr: string): Promise<GitleaksScanResult> {
  let raw: string
  try {
    raw = await readFile(reportPath, 'utf8')
  } catch {
    // Exit code 1 without a readable report: fail closed with context. The
    // stderr log lines are already redacted because the scan runs with --redact.
    return {
      status: 'error',
      message: trimSnippet(`gitleaks meldete Funde, aber der JSON-Report ist nicht lesbar. ${stderr}`)
    }
  }
  const result = parseGitleaksReport(raw)
  if (result.status === 'clean') {
    // Exit code 1 with an empty report is contradictory — never wave it through.
    return {
      status: 'error',
      message: trimSnippet(`gitleaks meldete Exit-Code 1, aber der Report enthält keine Funde. ${stderr}`)
    }
  }
  return result
}

/**
 * Scans the staged changes of a worktree with gitleaks.
 * - clean: gitleaks ran and found nothing.
 * - findings: parsed, redacted findings from the JSON report.
 * - unavailable: the binary is not installed (spawn ENOENT).
 * - error: timeout, crash, unexpected exit code, or unusable report.
 */
export async function scanStagedWithGitleaks(worktree: string): Promise<GitleaksScanResult> {
  const probe = await runGitleaks(worktree, ['version'], PROBE_TIMEOUT_MS)
  if (probe.error) {
    if (probe.error.code === 'ENOENT') return { status: 'unavailable' }
    if (probe.error.killed || probe.error.signal) {
      return { status: 'error', message: 'gitleaks-Versionsermittlung wurde abgebrochen (Timeout/Signal).' }
    }
    return {
      status: 'error',
      message: trimSnippet(`gitleaks-Versionsermittlung fehlgeschlagen: ${probe.stderr || probe.error.message}`)
    }
  }
  const version = parseGitleaksVersion(probe.stdout || probe.stderr)

  let reportDir: string | undefined
  try {
    reportDir = await mkdtemp(join(tmpdir(), 'vertragus-gitleaks-'))
    const reportPath = join(reportDir, 'report.json')
    const scan = await runGitleaks(worktree, stagedScanArgs(version, reportPath), SCAN_TIMEOUT_MS)
    if (!scan.error) return { status: 'clean' }
    if (scan.error.code === 'ENOENT') return { status: 'unavailable' }
    if (scan.error.killed || scan.error.signal) {
      return {
        status: 'error',
        message:
          `gitleaks-Scan wurde abgebrochen (Timeout ${SCAN_TIMEOUT_MS / 1000} s` +
          `${scan.error.signal ? `, Signal ${scan.error.signal}` : ''}).`
      }
    }
    if (scan.error.code === 1) {
      // Exit code 1 means "leaks encountered"; the findings live in the report.
      return await readReport(reportPath, scan.stderr)
    }
    return {
      status: 'error',
      message: trimSnippet(
        `gitleaks beendete sich mit Exit-Code ${String(scan.error.code)}: ${scan.stderr || scan.error.message}`
      )
    }
  } catch (error) {
    return {
      status: 'error',
      message: trimSnippet(`gitleaks-Scan fehlgeschlagen: ${error instanceof Error ? error.message : String(error)}`)
    }
  } finally {
    if (reportDir) await rm(reportDir, { recursive: true, force: true }).catch(() => undefined)
  }
}
