import type { TaskGateFinding } from '@shared/orchestrator'
import { noTaskChanges, verifiedTaskCommit } from './commitContract'
import {
  evaluateSecurityGate,
  SecurityGateError
} from './securityGate'
import {
  assertStagedHygiene,
  CommitHygieneError,
  git,
  isAncestor,
  safeSlug,
  scratchFiles,
  stagedFileList,
  unstageScratchFiles
} from './autoPr/gitPlumbing'
import {
  assertDiffLooksSafe,
  assertSecretScanGates,
  QualityGateError,
  qualityGateEnvironment,
  qualityGateShellCommand,
  runGatesWithBootstrapRetry,
  runIntegrationQualityGates,
  runQualityGates
} from './autoPr/gates'
import {
  combineRemoteCi,
  monitorRemoteCi,
  parseRemoteChecks,
  remoteCiFromChecks
} from './autoPr/ciMonitor'
import { defaultBase, pickBaseBranch, publishPreparedChanges } from './autoPr/prPublish'
import type {
  PreparedTaskChange,
  PrepareTaskInput,
  PrepareTaskResult
} from './autoPr/types'

export { scratchFiles, pickBaseBranch, publishPreparedChanges }
export type {
  PreparedTaskChange,
  AutoPrOutcome,
  PrepareTaskResult
} from './autoPr/types'
export type {
  RemoteCiOutcome,
  RemoteCiCommandResult
} from './autoPr/ciMonitor'

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
        'commit', '-m', `vertragus(${input.taskId}): needs work - ${input.title.trim().slice(0, 60)}`
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

/** Above this many files in one task commit an advisory granularity finding is raised. */
const COMMIT_GRANULARITY_ADVISORY_THRESHOLD = 25

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
    // Only soft-reset onto the recorded base when it is genuinely an ancestor of
    // HEAD. A diverged follow-up plan (HEAD moved past/beside the base) would
    // otherwise drop the delivered commits — the retro "follow-up plan cannot see
    // delivered code" (mrnchpk2). In that case fall back to the real merge-base.
    if (baseCommit && initialHead !== baseCommit) {
      let resetTarget = baseCommit
      if (!(await isAncestor(input.worktree, baseCommit, initialHead))) {
        const mergeBase = (await git(input.worktree, ['merge-base', baseCommit, initialHead])).trim()
        if (!mergeBase) {
          throw new Error(
            `Commit-Vertrag verletzt: Basis ${baseCommit.slice(0, 8)} ist kein Vorfahre von HEAD und ` +
              'besitzt keinen gemeinsamen Merge-Base — gelieferte Commits würden verloren gehen.'
          )
        }
        baseCommit = mergeBase
        resetTarget = mergeBase
      }
      await git(input.worktree, ['reset', '--soft', resetTarget])
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
      // Secret gate over the staged state: builtin regexes, gitleaks, or both
      // depending on AutoPrConfig.secretScanner.
      await assertSecretScanGates(
        input.worktree,
        await git(input.worktree, ['diff', '--cached', '--no-ext-diff', '--binary']),
        input.config
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
      await assertSecretScanGates(input.worktree, stagedDiff, input.config)
    }
    const stagedFiles = await stagedFileList(input.worktree)

    if (stagedFiles.length > 0) {
      await git(input.worktree, [
        'commit', '-m', 'vertragus(' + input.taskId + '): ' + input.title.trim().slice(0, 72)
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
    // Advisory only — oversized late-phase commits are a review burden and a
    // recurring retro finding, but they must never block a verified delivery.
    if (files.length > COMMIT_GRANULARITY_ADVISORY_THRESHOLD && commits.length === 1) {
      hygieneFindings.push({
        gate: 'commit',
        code: 'commit-granularity',
        message:
          `Task-Commit umfasst ${files.length} Dateien in einem einzigen Commit — ` +
          'für späte Phasen kleinere, thematisch getrennte Commits bevorzugen.',
        files: files.slice(0, 32)
      })
    }
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
