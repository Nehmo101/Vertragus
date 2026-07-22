/**
 * Side-effect-free scoring of a delegation estimate against the actual run.
 *
 * The engine derives a {@link PlanDelegationEstimate} from the plan before it
 * runs; after the plan is terminal this module compares that estimate to what
 * the subagents actually produced and returns a verdict for the retro. Keeping
 * it pure means the whole solo-vs-team feedback loop is unit-testable without
 * the orchestration engine.
 */
import type {
  OrchestratorDelegationEstimate,
  PlanDelegationEstimate
} from '../planEstimate'
import type { TaskFailureKind, TaskStatus } from '../orchestrator'
import type {
  CalibrationGrade,
  DelegationOutcome,
  DelegationRetro,
  DelegationTaskObservation,
  DelegationVerdict,
  SelfCalibration
} from './contracts'

/** Peak number of tasks whose [startedAt, finishedAt] intervals overlap. */
function peakParallel(observations: readonly DelegationTaskObservation[]): number {
  const events: Array<{ at: number; delta: number }> = []
  for (const observation of observations) {
    const { startedAt, finishedAt } = observation
    if (startedAt == null || finishedAt == null || finishedAt < startedAt) continue
    events.push({ at: startedAt, delta: 1 })
    events.push({ at: finishedAt, delta: -1 })
  }
  if (events.length === 0) return 0
  // Close intervals (delta -1) before opening (delta +1) at an identical
  // timestamp so back-to-back tasks are not counted as overlapping.
  events.sort((a, b) => a.at - b.at || a.delta - b.delta)
  let current = 0
  let peak = 0
  for (const event of events) {
    current += event.delta
    if (current > peak) peak = current
  }
  return peak
}

function isFailed(status: TaskStatus): boolean {
  return status === 'error' || status === 'stopped'
}

export function deriveDelegationOutcome(
  observations: readonly DelegationTaskObservation[]
): DelegationOutcome {
  // A logical multiagent parent is a container, not a real worker process: its
  // interval spans the whole competing group, so counting it would inflate both
  // the dispatched total and peak parallelism (the real "6 = 5 candidates + 1
  // logical parent" bug). Score only real worker tasks.
  const workers = observations.filter((observation) => !observation.multiAgentParent)
  return {
    dispatchedTasks: workers.length,
    committedTasks: workers.filter((observation) => observation.committed).length,
    noChangeTasks: workers.filter((observation) => observation.noChanges).length,
    failedTasks: workers.filter((observation) => isFailed(observation.status)).length,
    observedPeakParallel: peakParallel(workers),
    multiAgentCandidates: workers.filter((observation) => observation.multiAgentCandidate).length,
    infraFailedTasks: workers.filter(
      (observation) => isFailed(observation.status) && observation.failureKind === 'infrastructure'
    ).length
  }
}

/** Minimal task projection the retro mapping accepts (VertragusTask is compatible). */
export interface DelegationTaskProjection {
  status: TaskStatus
  completion?: { kind?: string }
  createdAt?: number
  finishedAt?: number
  failureKind?: TaskFailureKind
  multiAgentRunId?: string
  multiAgentParentTaskId?: string
  multiAgentCandidate?: number
}

/**
 * Map a runtime task to a delegation observation, classifying it as one of:
 * a real worker, a multiagent candidate, or a purely logical multiagent parent.
 * The parent carries a run id but no candidate number; a candidate carries a
 * candidate number. Everything else is an ordinary logical/worker task.
 */
export function toDelegationObservation(
  task: DelegationTaskProjection
): DelegationTaskObservation {
  const isCandidate = task.multiAgentCandidate != null
  const isLogicalParent = task.multiAgentRunId != null && !isCandidate
  return {
    status: task.status,
    committed: task.completion?.kind === 'commit',
    noChanges: task.completion?.kind === 'no-changes',
    startedAt: task.createdAt,
    finishedAt: task.finishedAt,
    failureKind: task.failureKind,
    multiAgentParent: isLogicalParent,
    multiAgentCandidate: isCandidate
  }
}

/**
 * A deliberate multiagent fan-out: a single logical task run as N≥2 competing
 * candidates. Every dispatched worker is a candidate, so this is a requested
 * comparison — not an over-delegated team, and not to be scored as one.
 */
function isDeliberateFanout(outcome: DelegationOutcome): boolean {
  return outcome.multiAgentCandidates >= 2 && outcome.multiAgentCandidates === outcome.dispatchedTasks
}

function judge(
  estimate: PlanDelegationEstimate,
  outcome: DelegationOutcome
): { verdict: DelegationVerdict; note: string } {
  const { dispatchedTasks, committedTasks, noChangeTasks, failedTasks, infraFailedTasks } = outcome
  if (dispatchedTasks === 0) {
    return { verdict: 'inconclusive', note: 'Keine terminalen Subagent-Tasks beobachtet.' }
  }

  // Every worker failed on infrastructure/transport (e.g. the Cursor prompt
  // never arrived): the model never got a fair chance, so the delegation
  // decision is inconclusive rather than "over-delegated".
  if (infraFailedTasks === dispatchedTasks) {
    return {
      verdict: 'inconclusive',
      note:
        `Alle ${dispatchedTasks} Worker scheiterten an Infrastruktur/Transport ` +
        '— kein aussagekräftiges Delegationsergebnis (Kalibrierung ausgesetzt).'
    }
  }

  // A requested multiagent comparison of one logical task is never blanket
  // overhead: judge it by whether the competition produced an integrable result.
  if (isDeliberateFanout(outcome)) {
    if (committedTasks >= 1) {
      return {
        verdict: 'justified',
        note:
          `Multiagent-Wettbewerb: ${dispatchedTasks} Kandidaten verglichen, ` +
          `${committedTasks} mit integrierbarem Ergebnis.`
      }
    }
    return {
      verdict: 'inconclusive',
      note:
        `Multiagent-Wettbewerb mit ${dispatchedTasks} Kandidaten ohne integrierbares Ergebnis ` +
        `(${noChangeTasks}× keine Änderung, ${failedTasks}× fehlgeschlagen).`
    }
  }

  if (estimate.recommendation === 'solo') {
    if (dispatchedTasks <= 1) {
      return {
        verdict: 'justified',
        note: `Solo-Einschätzung bestätigt: ${dispatchedTasks} Task ausgeführt, kein Team nötig.`
      }
    }
    return {
      verdict: 'overhead',
      note:
        `Solo empfohlen, aber ${dispatchedTasks} Subagents gestartet ` +
        `(davon ${committedTasks} mit echten Änderungen). Ein einzelner Agent hätte vermutlich gereicht.`
    }
  }

  // recommendation === 'delegate'
  if (committedTasks >= 2) {
    const base = `Delegation gerechtfertigt: ${committedTasks} Subagents lieferten echte Änderungen.`
    if (estimate.underParallelized) {
      return {
        verdict: 'justified',
        note:
          `${base} Hinweis: maxParallel serialisierte die ${estimate.effectiveParallelWidth} ` +
          'Stränge — künftig maxParallel erhöhen.'
      }
    }
    return { verdict: 'justified', note: base }
  }
  if (dispatchedTasks >= 2 && committedTasks <= 1) {
    return {
      verdict: 'overhead',
      note:
        `Team aus ${dispatchedTasks} Subagents gestartet, aber nur ${committedTasks} lieferte(n) echte ` +
        `Änderungen (${noChangeTasks}× keine Änderung, ${failedTasks}× fehlgeschlagen). ` +
        'Solo hätte hier vermutlich gereicht.'
    }
  }
  return {
    verdict: 'inconclusive',
    note: `Delegation empfohlen; Ergebnis nicht eindeutig (${committedTasks}/${dispatchedTasks} mit Änderungen).`
  }
}

/**
 * Calibrate the orchestrator's OWN prediction against the structural anchor and
 * the real outcome. "Warranted" means the run actually produced parallel work
 * (two or more subagents committed real changes); the grade tells the
 * orchestrator whether it tends to over- or under-delegate.
 */
function calibrate(
  selfEstimate: OrchestratorDelegationEstimate,
  estimate: PlanDelegationEstimate,
  outcome: DelegationOutcome
): SelfCalibration {
  const agreedWithStructure = selfEstimate.recommendation === estimate.recommendation
  const warranted = outcome.committedTasks >= 2
  const infraWipeout = outcome.dispatchedTasks > 0 && outcome.infraFailedTasks === outcome.dispatchedTasks
  let grade: CalibrationGrade
  if (outcome.dispatchedTasks === 0 || infraWipeout) {
    // No real signal, or a shared infrastructure/transport failure masked the
    // model — do not blame the delegation call in either direction.
    grade = 'unclear'
  } else if (isDeliberateFanout(outcome)) {
    // A requested comparison: accurate when it yielded an integrable result,
    // otherwise unclear — never "over-delegated" for a single logical task.
    grade = outcome.committedTasks >= 1 ? 'accurate' : 'unclear'
  } else if (selfEstimate.recommendation === 'delegate') {
    grade = warranted ? 'accurate' : 'over-delegated'
  } else {
    grade = warranted ? 'under-delegated' : 'accurate'
  }
  const structure = agreedWithStructure
    ? 'deckt sich mit der Struktur'
    : `weicht von der Struktur-Einschätzung "${estimate.recommendation}" ab`
  return {
    agreedWithStructure,
    grade,
    note:
      `Selbst-Einschätzung "${selfEstimate.recommendation}" (${selfEstimate.confidence}) ${structure}; ` +
      `real ${outcome.committedTasks}/${outcome.dispatchedTasks} Tasks mit Änderungen → ${grade}.`
  }
}

/** Compare a plan's delegation estimate to what the run actually produced. */
export function analyzeDelegation(
  estimate: PlanDelegationEstimate,
  observations: readonly DelegationTaskObservation[],
  selfEstimate?: OrchestratorDelegationEstimate
): DelegationRetro {
  const outcome = deriveDelegationOutcome(observations)
  const { verdict, note } = judge(estimate, outcome)
  return {
    estimate,
    selfEstimate,
    outcome,
    verdict,
    selfCalibration: selfEstimate ? calibrate(selfEstimate, estimate, outcome) : undefined,
    note
  }
}

export type DelegationBias = 'over-delegating' | 'under-delegating'

/** Rolling calibration trend across recent runs, used to nudge the next goal. */
export interface DelegationCalibrationTrend {
  runs: number
  overDelegated: number
  underDelegated: number
  accurate: number
  bias?: DelegationBias
  /** German one-liner surfaced at set_goal when a systematic bias shows up. */
  hint?: string
}

/**
 * Summarize the orchestrator's self-calibration over its most recent runs so a
 * systematic over- or under-delegation bias can be surfaced when it sets the
 * next goal — closing the loop exactly when the next estimate is about to be
 * made. Retros are expected newest-first (as the store returns them).
 */
export function summarizeDelegationCalibration(
  retros: ReadonlyArray<{ delegation?: DelegationRetro }>,
  options: { window?: number; minRuns?: number } = {}
): DelegationCalibrationTrend {
  const window = options.window ?? 6
  const minRuns = options.minRuns ?? 3
  const grades: CalibrationGrade[] = []
  for (const retro of retros) {
    const grade = retro.delegation?.selfCalibration?.grade
    if (grade && grade !== 'unclear') grades.push(grade)
    if (grades.length >= window) break
  }
  const runs = grades.length
  const overDelegated = grades.filter((grade) => grade === 'over-delegated').length
  const underDelegated = grades.filter((grade) => grade === 'under-delegated').length
  const accurate = grades.filter((grade) => grade === 'accurate').length

  let bias: DelegationBias | undefined
  let hint: string | undefined
  if (runs >= minRuns) {
    if (overDelegated >= underDelegated && overDelegated * 2 > runs) {
      bias = 'over-delegating'
      hint =
        `Kalibrier-Hinweis: In ${overDelegated}/${runs} der letzten Läufe hast du ein Team gestartet, ` +
        'obwohl solo gereicht hätte. Prüfe kritisch, ob dieses Ziel wirklich parallelisierbar ist.'
    } else if (underDelegated * 2 > runs) {
      bias = 'under-delegating'
      hint =
        `Kalibrier-Hinweis: In ${underDelegated}/${runs} der letzten Läufe hättest du delegieren sollen, ` +
        'hast aber solo geplant. Erwäge ein paralleles Team, wo Teilaufgaben unabhängig sind.'
    }
  }
  return { runs, overDelegated, underDelegated, accurate, bias, hint }
}
