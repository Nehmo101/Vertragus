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

export function deriveDelegationOutcome(
  observations: readonly DelegationTaskObservation[]
): DelegationOutcome {
  return {
    dispatchedTasks: observations.length,
    committedTasks: observations.filter((observation) => observation.committed).length,
    noChangeTasks: observations.filter((observation) => observation.noChanges).length,
    failedTasks: observations.filter(
      (observation) => observation.status === 'error' || observation.status === 'stopped'
    ).length,
    observedPeakParallel: peakParallel(observations)
  }
}

function judge(
  estimate: PlanDelegationEstimate,
  outcome: DelegationOutcome
): { verdict: DelegationVerdict; note: string } {
  const { dispatchedTasks, committedTasks, noChangeTasks, failedTasks } = outcome
  if (dispatchedTasks === 0) {
    return { verdict: 'inconclusive', note: 'Keine terminalen Subagent-Tasks beobachtet.' }
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
  let grade: CalibrationGrade
  if (outcome.dispatchedTasks === 0) {
    grade = 'unclear'
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
