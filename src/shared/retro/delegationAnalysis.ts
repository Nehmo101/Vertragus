/**
 * Side-effect-free scoring of a delegation estimate against the actual run.
 *
 * The engine derives a {@link PlanDelegationEstimate} from the plan before it
 * runs; after the plan is terminal this module compares that estimate to what
 * the subagents actually produced and returns a verdict for the retro. Keeping
 * it pure means the whole solo-vs-team feedback loop is unit-testable without
 * the orchestration engine.
 */
import type { PlanDelegationEstimate } from '../planEstimate'
import type {
  DelegationOutcome,
  DelegationRetro,
  DelegationTaskObservation,
  DelegationVerdict
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

/** Compare a plan's delegation estimate to what the run actually produced. */
export function analyzeDelegation(
  estimate: PlanDelegationEstimate,
  observations: readonly DelegationTaskObservation[]
): DelegationRetro {
  const outcome = deriveDelegationOutcome(observations)
  const { verdict, note } = judge(estimate, outcome)
  return { estimate, outcome, verdict, note }
}
