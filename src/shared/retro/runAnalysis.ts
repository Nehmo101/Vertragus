import type {
  AnalyzeRunRetroInput,
  NewModelLearning,
  RetroDraftModel,
  RetroDraftResult,
  RetroFailureBreakdown,
  RetroFailureKind,
  RetroLearningTemplate,
  RetroModelStats,
  RetroTaskObservation,
  RunRetro,
  RunRetroAnalysis
} from './contracts'

const EMPTY_FAILURE_BREAKDOWN = (): RetroFailureBreakdown => ({
  infra: 0,
  cancelled: 0,
  model: 0
})

const INFRA_FAILURE_PATTERNS = [
  /\bat capacity\b/i,
  /\b(?:provider|service|server)\b.{0,100}\b(?:capacity|kapazit(?:\u00e4|ae)t|overloaded|(?:\u00fc|ue)berlastet|ausgelastet|unavailable|nicht verf(?:\u00fc|ue)gbar)\b/i,
  /\b(?:429|too many requests|rate[- ]?limit(?:ed)?)\b/i,
  /ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY/i,
  /\beslint\b.{0,120}\b(?:not found|nicht gefunden|not recognized|nicht als name erkannt|enoent)\b/i,
  /\b(?:not found|nicht gefunden|not recognized|nicht als name erkannt|enoent)\b.{0,120}\beslint\b/i,
  /\bEPERM\b/i,
  /\bsandbox\b.{0,100}\b(?:failed|failure|fehler|permission|refus|verweigert)\w*/i,
  /\b(?:provider|dispatch|plan-dispatch)-infrastruktur\b/i,
  /provider bewertete den worker-abschluss als fehlgeschlagen/i
]

const CANCELLED_FAILURE_PATTERN =
  /\b(?:cancelled|canceled|abgebrochen|gestoppt|verworfen)\b|\b(?:plan|review)\b.{0,100}\b(?:abgelehnt|rejected)\b/i

function matchesKnownInfrastructureFailure(evidence: string): boolean {
  return INFRA_FAILURE_PATTERNS.some((pattern) => pattern.test(evidence))
}

function classifyRetroFailure(
  status: RetroTaskObservation['status'],
  failureKind: RetroTaskObservation['failureKind'],
  evidence: string
): RetroFailureKind {
  if (failureKind === 'cancelled' || status === 'stopped' || status === 'paused' || status === 'waiting') return 'cancelled'
  if (failureKind === 'infrastructure' || matchesKnownInfrastructureFailure(evidence)) return 'infra'
  if (CANCELLED_FAILURE_PATTERN.test(evidence)) return 'cancelled'
  return 'model'
}

function taskFailureEvidence(task: RetroTaskObservation): string {
  const lastAttempt = task.attempts?.[task.attempts.length - 1]
  return [
    task.judgeReason,
    task.note,
    task.blocker?.summary,
    ...(task.blocker?.details ?? []),
    ...(task.findings ?? []).flatMap((finding) => [finding.code, finding.message]),
    lastAttempt?.note
  ].filter((value): value is string => typeof value === 'string' && value.length > 0).join('\n')
}

function countCodeGateFindings(
  task: RetroTaskObservation,
  failureKind: RetroFailureKind
): number {
  if (failureKind === 'infra' || failureKind === 'cancelled') return 0
  return (task.findings ?? []).filter(
    (finding) =>
      finding.gate !== 'preflight' &&
      !matchesKnownInfrastructureFailure(finding.code + '\n' + finding.message)
  ).length
}

/**
 * Aggregate per provider/model stats from a plan's terminal task graph.
 * Failed worker attempts are attributed to the model that actually failed,
 * even when adaptive routing finished the task on another slot.
 */
export function deriveModelStats(tasks: readonly RetroTaskObservation[]): RetroModelStats[] {
  interface Accumulator extends RetroModelStats {
    durations: number[]
    hasTokensIn: boolean
    hasTokensOut: boolean
    hasCost: boolean
  }
  const groups = new Map<string, Accumulator>()
  const groupFor = (provider: RetroModelStats['provider'], model: string): Accumulator => {
    const key = `${provider}|${model.toLowerCase()}`
    let group = groups.get(key)
    if (!group) {
      group = {
        provider,
        model,
        roles: [],
        tasks: 0,
        succeeded: 0,
        needsWork: 0,
        failed: 0,
        stopped: 0,
        failuresByKind: EMPTY_FAILURE_BREAKDOWN(),
        failedAttempts: 0,
        failedAttemptsByKind: EMPTY_FAILURE_BREAKDOWN(),
        gateFindings: 0,
        durations: [],
        hasTokensIn: false,
        hasTokensOut: false,
        hasCost: false
      }
      groups.set(key, group)
    }
    return group
  }

  for (const task of tasks) {
    for (const attempt of task.attempts ?? []) {
      if (attempt.status !== 'error' || !attempt.provider) continue
      const attemptGroup = groupFor(attempt.provider, attempt.model ?? '')
      if (!attemptGroup.roles.includes(task.role)) attemptGroup.roles.push(task.role)
      const attemptFailureKind = classifyRetroFailure(
        attempt.status,
        attempt.failureKind,
        attempt.note ?? ''
      )
      attemptGroup.failedAttempts += 1
      attemptGroup.failedAttemptsByKind[attemptFailureKind] += 1
    }
    if (!task.provider) continue
    const group = groupFor(task.provider, task.model ?? '')
    const failureKind = classifyRetroFailure(
      task.status,
      task.failureKind,
      taskFailureEvidence(task)
    )
    group.tasks += 1
    if (!group.roles.includes(task.role)) group.roles.push(task.role)
    if (task.status === 'success') group.succeeded += 1
    else if (task.status === 'needs-work') group.needsWork += 1
    else if (task.status === 'error') {
      group.failed += 1
      group.failuresByKind[failureKind] += 1
    } else if (task.status === 'stopped') {
      group.stopped += 1
      group.failuresByKind[failureKind] += 1
    }
    group.gateFindings += countCodeGateFindings(task, failureKind)
    if (task.finishedAt && task.finishedAt > task.createdAt) {
      group.durations.push(task.finishedAt - task.createdAt)
    }
    if (task.usage?.tokensIn != null) {
      group.tokensIn = (group.tokensIn ?? 0) + task.usage.tokensIn
      group.hasTokensIn = true
    }
    if (task.usage?.tokensOut != null) {
      group.tokensOut = (group.tokensOut ?? 0) + task.usage.tokensOut
      group.hasTokensOut = true
    }
    if (task.usage?.costUsd != null) {
      group.costUsd = (group.costUsd ?? 0) + task.usage.costUsd
      group.hasCost = true
    }
  }

  return [...groups.values()]
    .filter((group) => group.tasks > 0 || group.failedAttempts > 0)
    .map(({ durations, hasTokensIn, hasTokensOut, hasCost, ...stats }) => ({
      ...stats,
      avgDurationMs: durations.length > 0
        ? Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length)
        : undefined,
      tokensIn: hasTokensIn ? stats.tokensIn : undefined,
      tokensOut: hasTokensOut ? stats.tokensOut : undefined,
      costUsd: hasCost ? stats.costUsd : undefined
    }))
    .sort((a, b) => b.tasks - a.tasks)
}

/**
 * Turn the shared run stats into a stable, copy-ready facts scaffold. Engine
 * callers resolve configured model defaults first; the fallback label is a
 * final guard for imported legacy observations with model:"".
 */
export function deriveRetroDraftModels(
  tasks: readonly RetroTaskObservation[]
): RetroDraftModel[] {
  const stats = deriveModelStats(tasks)
  const timed = stats
    .filter((entry) => entry.avgDurationMs != null)
    .sort((a, b) => a.avgDurationMs! - b.avgDurationMs!)
  const speedRanks = new Map(timed.map((entry, index) => [entry, index + 1]))

  return stats.map((entry) => {
    const model = entry.model.trim() || `default (${entry.provider}-cli)`
    const role = entry.roles[0] ?? 'worker'
    const hasModelConcern =
      entry.needsWork > 0 ||
      entry.gateFindings > 0 ||
      entry.failuresByKind.model > 0 ||
      entry.failedAttemptsByKind.model > 0
    const templateFor = (kind: RetroLearningTemplate['kind']): RetroLearningTemplate => ({
      provider: entry.provider,
      model,
      role,
      kind,
      insight: '',
      evidence: ''
    })
    const strengthTemplate = templateFor('strength')
    const weaknessTemplate = templateFor('weakness')
    return {
      provider: entry.provider,
      model,
      roles: [...entry.roles],
      taskBalance: {
        total: entry.tasks,
        success: entry.succeeded,
        needsWork: entry.needsWork,
        failed: entry.failed,
        stopped: entry.stopped
      },
      failuresByKind: { ...entry.failuresByKind },
      failedAttempts: entry.failedAttempts,
      failedAttemptsByKind: { ...entry.failedAttemptsByKind },
      gateFindings: entry.gateFindings,
      avgDurationMs: entry.avgDurationMs ?? null,
      speedRank: speedRanks.get(entry) ?? null,
      tokensIn: entry.tokensIn ?? null,
      tokensOut: entry.tokensOut ?? null,
      costUsd: entry.costUsd ?? null,
      // Single slot points at the more likely side; templates carry both.
      learningTemplate: hasModelConcern ? weaknessTemplate : strengthTemplate,
      learningTemplates: [strengthTemplate, weaknessTemplate]
    }
  })
}

/**
 * Deterministic, human-readable rendering of a retro draft for the enforced
 * retro gate. Lists per-model facts plus the symmetric strength/weakness
 * fill-in slots so the orchestrator only supplies honest insight/evidence.
 */
export function renderRetroDraftForPrompt(draft: RetroDraftResult): string {
  if (!draft.ok) {
    return `Kein Retro-Gerüst verfügbar (${draft.code}): ${draft.message}`
  }
  const lines: string[] = [
    `Retro-Gerüst für ${draft.planId} (${draft.status}): ${draft.summary}`,
    'Fülle je Modell Stärke UND Schwäche aus, sofern belegbar — ein Slot darf leer bleiben; erfinde keine Schwäche.'
  ]
  for (const model of draft.models) {
    const b = model.taskBalance
    const facts = [
      `${b.success}/${b.total} ok`,
      `needsWork ${b.needsWork}`,
      `failed ${b.failed}`,
      `stopped ${b.stopped}`
    ]
    if (model.gateFindings > 0) facts.push(`${model.gateFindings} Gate-Finding(s)`)
    if (model.speedRank != null) facts.push(`Speed-Rang ${model.speedRank}`)
    lines.push(`- ${model.provider}/${model.model} [${model.roles.join(', ') || 'worker'}]: ${facts.join(', ')}`)
    for (const template of model.learningTemplates) {
      lines.push(
        `    ${template.kind}: insight="" evidence=""  ` +
          `(provider=${template.provider} model=${template.model} role=${template.role})`
      )
    }
  }
  return lines.join('\n')
}

/**
 * Conservative heuristic learnings from run stats. Qualitative judgements
 * ("stark bei UI") come from the orchestrator via record_retro; these
 * heuristics only state what the run data proves.
 */
export function deriveHeuristicLearnings(
  stats: readonly RetroModelStats[],
  options: { profileId?: string } = {}
): NewModelLearning[] {
  const learnings: NewModelLearning[] = []
  const base = { source: 'auto-retro' as const, profileId: options.profileId }
  const rolesText = (entry: RetroModelStats): string => entry.roles.slice(0, 3).join(', ') || 'worker'

  for (const entry of stats) {
    const failuresByKind = entry.failuresByKind ?? {
      infra: 0,
      cancelled: entry.stopped,
      model: entry.failed
    }
    const failedAttemptsByKind = entry.failedAttemptsByKind ?? {
      infra: 0,
      cancelled: 0,
      model: entry.failedAttempts
    }
    const eligibleTasks = Math.max(
      0,
      entry.tasks - failuresByKind.infra - failuresByKind.cancelled
    )
    if (entry.tasks >= 2 && entry.succeeded === entry.tasks && entry.failedAttempts === 0) {
      learnings.push({
        ...base,
        provider: entry.provider,
        model: entry.model,
        role: entry.roles[0],
        kind: 'strength',
        insight: `zuverlässig im ersten Anlauf bei ${rolesText(entry)}`,
        evidence: `${entry.succeeded}/${entry.tasks} Tasks ohne Wiederholung erfolgreich`
      })
    }
    // Mindestens zwei auswertbare Beobachtungen: eine einzelne Task-Pleite
    // prägte sonst sofort ein generisches "fehleranfällig"-Learning
    // (Retro-Serie remote-selftest: observations 1→5 aus demselben Artefakt).
    if (
      eligibleTasks >= 2 &&
      failuresByKind.model > 0 &&
      failuresByKind.model * 2 >= eligibleTasks
    ) {
      learnings.push({
        ...base,
        provider: entry.provider,
        model: entry.model,
        role: entry.roles[0],
        kind: 'weakness',
        insight: `fehleranfällig bei ${rolesText(entry)}`,
        evidence: `${failuresByKind.model}/${eligibleTasks} auswertbare Tasks inhaltlich fehlgeschlagen`
      })
    }
    if (entry.needsWork > 0 && entry.gateFindings > 0) {
      learnings.push({
        ...base,
        provider: entry.provider,
        model: entry.model,
        role: entry.roles[0],
        kind: 'weakness',
        insight: `Quality-Gates erfordern Nacharbeit bei ${rolesText(entry)}`,
        evidence: `${entry.needsWork} Task(s) mit ${entry.gateFindings} Gate-Finding(s)`
      })
    }
    if (failedAttemptsByKind.model > 0 && entry.tasks === 0) {
      learnings.push({
        ...base,
        provider: entry.provider,
        model: entry.model,
        kind: 'weakness',
        insight: 'Worker-Versuche scheiterten; Aufgaben wurden auf andere Slots umgeleitet',
        evidence: `${failedAttemptsByKind.model} inhaltlich fehlgeschlagene(r) Versuch(e) in diesem Lauf`
      })
    }
  }

  // Compare speed only when at least two models succeeded and the fastest is
  // clearly (at least 30 percent) ahead.
  const timed = stats.filter((entry) => entry.succeeded > 0 && entry.avgDurationMs != null)
  if (timed.length >= 2) {
    const sorted = [...timed].sort((a, b) => a.avgDurationMs! - b.avgDurationMs!)
    const fastest = sorted[0]
    const slowest = sorted[sorted.length - 1]
    if (fastest.avgDurationMs! < slowest.avgDurationMs! * 0.7) {
      learnings.push({
        ...base,
        provider: fastest.provider,
        model: fastest.model,
        role: fastest.roles[0],
        kind: 'strength',
        insight: `deutlich schnellstes Modell dieses Laufs (Ø ${Math.round(fastest.avgDurationMs! / 1000)}s)`,
        evidence: `Ø-Dauer ${Math.round(fastest.avgDurationMs! / 1000)}s gegenüber ${Math.round(slowest.avgDurationMs! / 1000)}s (${slowest.provider}/${slowest.model || 'Standard'})`
      })
    }
  }

  return learnings
}

const RETRO_STATUS_LABEL: Record<NonNullable<RunRetro['status']>, string> = {
  success: 'erfolgreich',
  'needs-work': 'mit Nacharbeit',
  error: 'mit Fehlern',
  stopped: 'gestoppt'
}

/** Compact German one-liner for the retro card / stored record. */
export function summarizeRetro(
  stats: readonly RetroModelStats[],
  status?: RunRetro['status']
): string {
  const tasks = stats.reduce((sum, entry) => sum + entry.tasks, 0)
  const succeeded = stats.reduce((sum, entry) => sum + entry.succeeded, 0)
  const label = status ? `Lauf ${RETRO_STATUS_LABEL[status]}` : 'Lauf ausgewertet'
  return `${label}: ${stats.length} Modell(e), ${succeeded}/${tasks} Tasks erfolgreich.`
}

/** Run the complete pure analysis before the engine performs persistence. */
export function analyzeRunRetro(input: AnalyzeRunRetroInput): RunRetroAnalysis {
  const modelStats = deriveModelStats(input.tasks)
  return {
    modelStats,
    learnings: deriveHeuristicLearnings(modelStats, { profileId: input.profileId }),
    summary: summarizeRetro(modelStats, input.status)
  }
}
