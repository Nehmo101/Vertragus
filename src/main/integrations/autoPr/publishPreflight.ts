/**
 * Publish preflight: cheap, local checks BEFORE the first push/PR attempt.
 * Retro series mrl9*: workers burned five plan iterations on publish failures
 * whose causes (missing auth, stale base, casing-conflicting remote branch)
 * were all detectable up front. The preflight condenses them into ONE
 * structured finding set instead of a blind retry loop.
 */
import type { TaskGateFinding } from '@shared/orchestrator'
import { git as defaultGit } from './gitPlumbing'

export interface PublishPreflightInput {
  cwd: string
  /** Branch the publish step is about to create/push. */
  branch: string
  /** Base branch the PR will target. */
  base: string
}

export interface PublishPreflightResult {
  ok: boolean
  findings: TaskGateFinding[]
  /** True when origin/<base> is behind — a fetch/rebase is advisable first. */
  behindBase: boolean
}

type GitRunner = (cwd: string, args: string[]) => Promise<string>

export async function runPublishPreflight(
  input: PublishPreflightInput,
  gitRunner: GitRunner = defaultGit
): Promise<PublishPreflightResult> {
  const findings: TaskGateFinding[] = []
  let behindBase = false

  // 1. Remote reachability + auth probe in one call: a dry-run push fails on
  //    missing credentials or a rejected ref without transferring objects.
  try {
    await gitRunner(input.cwd, ['push', '--dry-run', 'origin', `HEAD:refs/heads/${input.branch}`])
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    const authProblem = /auth|permission|denied|403|401|could not read Username|terminal prompts disabled/i.test(detail)
    findings.push({
      gate: 'preflight',
      code: authProblem ? 'push-auth' : 'push-refused',
      message: authProblem
        ? 'Push-Probe abgelehnt: GitHub-Anmeldung/Berechtigung fehlt. Erst Auth herstellen, dann publizieren.'
        : `Push-Probe abgelehnt: ${detail.slice(0, 300)}`
    })
  }

  // 2. Exact-casing branch collision: GitHub treats refs case-sensitively but
  //    some filesystems don't — a remote branch differing only in casing makes
  //    pushes/PRs fail confusingly.
  try {
    const heads = (await gitRunner(input.cwd, ['ls-remote', '--heads', 'origin']))
      .split(/\r?\n/)
      .map((line) => line.split('\t')[1]?.replace('refs/heads/', '').trim())
      .filter((name): name is string => Boolean(name))
    const lower = input.branch.toLowerCase()
    const collision = heads.find((name) => name.toLowerCase() === lower && name !== input.branch)
    if (collision) {
      findings.push({
        gate: 'preflight',
        code: 'branch-casing-conflict',
        message: `Remote-Branch "${collision}" unterscheidet sich nur in Groß-/Kleinschreibung von "${input.branch}".`
      })
    }
  } catch {
    // ls-remote failures are already covered by the push probe.
  }

  // 3. Ahead/behind vs the PR base: a base that moved on means the local work
  //    should be rebased/refreshed before opening the PR.
  try {
    const counts = (await gitRunner(input.cwd, [
      'rev-list', '--left-right', '--count', `origin/${input.base}...HEAD`
    ])).trim().split(/\s+/)
    const behind = Number(counts[0] ?? '0')
    const ahead = Number(counts[1] ?? '0')
    if (Number.isFinite(behind) && behind > 0) {
      behindBase = true
      findings.push({
        gate: 'preflight',
        code: 'base-moved',
        message: `origin/${input.base} ist ${behind} Commit(s) voraus; vor dem PR aktualisieren (fetch/rebase).`
      })
    }
    if (Number.isFinite(ahead) && ahead === 0) {
      findings.push({
        gate: 'preflight',
        code: 'nothing-to-publish',
        message: `HEAD enthält keine Commits jenseits von origin/${input.base}.`
      })
    }
  } catch {
    // Unknown base locally: not fatal — publish resolves the base itself.
  }

  const blocking = findings.some((finding) =>
    finding.code === 'push-auth' || finding.code === 'branch-casing-conflict'
  )
  return { ok: !blocking, findings, behindBase }
}

/** One compact human-readable summary line for logs/results. */
export function formatPreflightFindings(findings: TaskGateFinding[]): string {
  if (findings.length === 0) return 'Publish-Preflight ohne Befund.'
  return `Publish-Preflight: ${findings.map((finding) => `[${finding.code}] ${finding.message}`).join(' · ')}`
}
