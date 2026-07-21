import type { RemoteCiStatus } from '@shared/orchestrator'
import { execFileAsync, MAX_OUTPUT } from './gitPlumbing'

const REMOTE_CI_REGISTRATION_TIMEOUT_MS = 90_000
const REMOTE_CI_TOTAL_TIMEOUT_MS = 20 * 60_000
const REMOTE_CI_POLL_MS = 5_000
const REMOTE_CI_READ_TIMEOUT_MS = 30_000
const REMOTE_CHECK_FIELDS = 'bucket,link,name,state,workflow'

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

export function parseRemoteChecks(raw: string): RemoteCheckRow[] {
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

export function remoteCiFromChecks(checks: RemoteCheckRow[], prUrl: string): RemoteCiOutcome {
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

export function combineRemoteCi(outcomes: RemoteCiOutcome[]): RemoteCiOutcome {
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

export async function monitorRemoteCi(
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

      // `gh pr checks --watch` is itself a terminal signal: it exits 0 when
      // every check passed and non-zero (--fail-fast) once one failed. The old
      // code discarded that exit code and did a single follow-up read, which
      // races GitHub's eventual-consistency window right after --watch returns
      // and mislabels green PRs as timed-out -> stopped (retros mrqulr14,
      // mrn5pdnn). Re-poll briefly for a detailed terminal read, then fall back
      // to the watch exit code instead of declaring a timeout.
      const finalDeadline = Math.min(
        deps.now() + REMOTE_CI_READ_TIMEOUT_MS,
        startedAt + REMOTE_CI_TOTAL_TIMEOUT_MS
      )
      let lastFinalUrl = current.url || input.prUrl
      let reads = 0
      while (deps.now() <= finalDeadline || reads === 0) {
        reads += 1
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
          lastFinalUrl = finalOutcome.url || lastFinalUrl
        }
        if (deps.now() > finalDeadline) break
        await deps.delay(REMOTE_CI_POLL_MS)
      }
      if (watched.exitCode === 0) {
        return report({
          status: 'passed',
          message: 'Remote-CI grün (über gh --watch bestätigt).',
          url: lastFinalUrl
        })
      }
      return report({
        status: 'timed-out',
        message: 'Remote-CI-Watch endete ohne terminales Ergebnis.',
        url: lastFinalUrl
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
