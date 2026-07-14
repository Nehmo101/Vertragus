/**
 * Retro / model-learning / benchmark types shared across processes.
 *
 * After every terminal plan run the engine derives a retrospective from the
 * task graph (per-model stats + heuristic learnings). The orchestrator adds
 * qualitative learnings via record_retro, benchmark runs add scored rankings
 * via record_benchmark. All learnings flow back into list_subagents so the
 * orchestrator routes future work with accumulated model knowledge.
 */
import type { AgentProviderId } from './providers'
import type { OrcaTask, TaskStatusSnapshot } from './orchestrator'

export type LearningKind = 'strength' | 'weakness'
export type LearningSource = 'auto-retro' | 'orchestrator' | 'benchmark'

/** One persisted per-model insight, e.g. "sehr stark bei UI-Aufgaben". */
export interface ModelLearning {
  id: string
  provider: AgentProviderId
  /** Resolved model name; empty string = provider CLI default. */
  model: string
  /** Role context the insight was observed in, e.g. "frontend". */
  role?: string
  kind: LearningKind
  /** Short German insight suitable for routing decisions. */
  insight: string
  /** Concrete observation backing the insight (run stats, score, verdict). */
  evidence?: string
  source: LearningSource
  profileId?: string
  /** How often this insight was (re-)confirmed across runs. */
  observations: number
  createdAt: number
  updatedAt: number
}

/** A learning before it is merged into the persistent store. */
export interface NewModelLearning {
  provider: AgentProviderId
  model: string
  role?: string
  kind: LearningKind
  insight: string
  evidence?: string
  source: LearningSource
  profileId?: string
}

/** Aggregated per provider/model stats for one plan run. */
export interface RetroModelStats {
  provider: AgentProviderId
  model: string
  roles: string[]
  tasks: number
  succeeded: number
  needsWork: number
  failed: number
  stopped: number
  /** Worker-attempt failures attributed to this model (incl. rerouted tasks). */
  failedAttempts: number
  gateFindings: number
  avgDurationMs?: number
  tokensIn?: number
  tokensOut?: number
  costUsd?: number
}

/** Retrospective of one plan run (or an ad-hoc orchestrator retro). */
export interface RunRetro {
  id: string
  profileId?: string
  workspaceSessionId?: string
  planId: string
  goal: string
  /** Absent for ad-hoc retros recorded outside a plan run. */
  status?: 'success' | 'needs-work' | 'error' | 'stopped'
  summary: string
  modelStats: RetroModelStats[]
  /** Learnings recorded for this run (heuristic + orchestrator). */
  learnings: ModelLearning[]
  createdAt: number
}

/** One scored contestant of a benchmark run, judged by the orchestrator. */
export interface BenchmarkRanking {
  role: string
  provider?: AgentProviderId
  model?: string
  /** 0..10 as judged by the orchestrator. */
  score: number
  verdict: string
  strengths: string[]
  weaknesses: string[]
  durationMs?: number
  tokens?: number
}

export interface BenchmarkRecord {
  id: string
  benchmarkId: string
  profileId?: string
  /** The shared task every slot executed. */
  task: string
  summary: string
  rankings: BenchmarkRanking[]
  createdAt: number
}

/** Live/polling view of a benchmark fan-out. */
export interface BenchmarkRunStatus {
  benchmarkId: string
  title: string
  status: 'running' | 'completed'
  tasks: Array<TaskStatusSnapshot & { durationMs?: number }>
}

const MAX_LEARNINGS_PER_MODEL_KIND = 12
const MAX_LEARNINGS_TOTAL = 400

function normalizeInsight(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

/** Stable dedup key: the same insight for the same model merges instead of duplicating. */
export function learningKey(
  learning: Pick<ModelLearning, 'provider' | 'model' | 'kind' | 'insight'>
): string {
  return [
    learning.provider,
    learning.model.trim().toLowerCase(),
    learning.kind,
    normalizeInsight(learning.insight).toLowerCase()
  ].join('|')
}

export interface MergedLearnings {
  all: ModelLearning[]
  /** The merged entries corresponding to the additions (new or reinforced). */
  applied: ModelLearning[]
}

/**
 * Merge new learnings into the store: identical insights are reinforced
 * (observations + fresher evidence) instead of duplicated. Bounded per
 * model+kind and globally so the store never grows without limit.
 */
export function mergeModelLearnings(
  existing: ModelLearning[],
  additions: NewModelLearning[],
  now: number = Date.now()
): MergedLearnings {
  const byKey = new Map<string, ModelLearning>()
  for (const entry of existing) byKey.set(learningKey(entry), entry)

  const applied: ModelLearning[] = []
  let seq = 0
  for (const addition of additions) {
    const insight = normalizeInsight(addition.insight)
    if (!insight) continue
    const key = learningKey({ ...addition, insight })
    const current = byKey.get(key)
    if (current) {
      const updated: ModelLearning = {
        ...current,
        observations: current.observations + 1,
        evidence: addition.evidence ?? current.evidence,
        role: addition.role ?? current.role,
        source: addition.source,
        updatedAt: now
      }
      byKey.set(key, updated)
      applied.push(updated)
      continue
    }
    seq += 1
    const created: ModelLearning = {
      id: `learning-${now.toString(36)}-${seq.toString(36)}-${Math.abs(hashCode(key)).toString(36)}`,
      provider: addition.provider,
      model: addition.model.trim(),
      role: addition.role,
      kind: addition.kind,
      insight,
      evidence: addition.evidence,
      source: addition.source,
      profileId: addition.profileId,
      observations: 1,
      createdAt: now,
      updatedAt: now
    }
    byKey.set(key, created)
    applied.push(created)
  }

  // Cap per provider+model+kind, keeping the best-confirmed, freshest entries.
  const groups = new Map<string, ModelLearning[]>()
  for (const entry of byKey.values()) {
    const groupKey = `${entry.provider}|${entry.model.toLowerCase()}|${entry.kind}`
    const group = groups.get(groupKey) ?? []
    group.push(entry)
    groups.set(groupKey, group)
  }
  let all: ModelLearning[] = []
  for (const group of groups.values()) {
    group.sort((a, b) => b.observations - a.observations || b.updatedAt - a.updatedAt)
    all.push(...group.slice(0, MAX_LEARNINGS_PER_MODEL_KIND))
  }
  if (all.length > MAX_LEARNINGS_TOTAL) {
    all = all
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, MAX_LEARNINGS_TOTAL)
  }
  all.sort((a, b) => b.updatedAt - a.updatedAt)
  const kept = new Set(all.map((entry) => entry.id))
  return { all, applied: applied.filter((entry) => kept.has(entry.id)) }
}

function hashCode(value: string): number {
  let hash = 0
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash << 5) - hash + value.charCodeAt(i)
    hash |= 0
  }
  return hash
}

/** Top learnings for one provider/model, ready for routing surfaces. */
export function selectLearningTexts(
  learnings: ModelLearning[],
  provider: AgentProviderId,
  model: string,
  limit = 6
): { strengths: string[]; weaknesses: string[] } {
  const normalizedModel = model.trim().toLowerCase()
  const matches = learnings
    .filter(
      (entry) =>
        entry.provider === provider &&
        (normalizedModel === '' || entry.model.trim().toLowerCase() === normalizedModel)
    )
    .sort((a, b) => b.observations - a.observations || b.updatedAt - a.updatedAt)
  return {
    strengths: matches.filter((entry) => entry.kind === 'strength').slice(0, limit).map((entry) => entry.insight),
    weaknesses: matches.filter((entry) => entry.kind === 'weakness').slice(0, limit).map((entry) => entry.insight)
  }
}

/**
 * Aggregate per provider/model stats from a plan's terminal task graph.
 * Failed worker attempts are attributed to the model that actually failed,
 * even when adaptive routing finished the task on another slot.
 */
export function deriveModelStats(tasks: OrcaTask[]): RetroModelStats[] {
  interface Accumulator extends RetroModelStats {
    durations: number[]
    hasTokensIn: boolean
    hasTokensOut: boolean
    hasCost: boolean
  }
  const groups = new Map<string, Accumulator>()
  const groupFor = (provider: AgentProviderId, model: string): Accumulator => {
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
        failedAttempts: 0,
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
      groupFor(attempt.provider, attempt.model ?? '').failedAttempts += 1
    }
    if (!task.provider) continue
    const group = groupFor(task.provider, task.model ?? '')
    group.tasks += 1
    if (!group.roles.includes(task.role)) group.roles.push(task.role)
    if (task.status === 'success') group.succeeded += 1
    else if (task.status === 'needs-work') group.needsWork += 1
    else if (task.status === 'error') group.failed += 1
    else if (task.status === 'stopped') group.stopped += 1
    group.gateFindings += task.findings?.length ?? 0
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
 * Conservative heuristic learnings from run stats. Qualitative judgements
 * ("stark bei UI") come from the orchestrator via record_retro; these
 * heuristics only state what the run data proves.
 */
export function deriveHeuristicLearnings(
  stats: RetroModelStats[],
  options: { profileId?: string } = {}
): NewModelLearning[] {
  const learnings: NewModelLearning[] = []
  const base = { source: 'auto-retro' as const, profileId: options.profileId }
  const rolesText = (entry: RetroModelStats): string => entry.roles.slice(0, 3).join(', ') || 'worker'

  for (const entry of stats) {
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
    if (entry.tasks > 0 && entry.failed * 2 >= entry.tasks && entry.failed > 0) {
      learnings.push({
        ...base,
        provider: entry.provider,
        model: entry.model,
        role: entry.roles[0],
        kind: 'weakness',
        insight: `fehleranfällig bei ${rolesText(entry)}`,
        evidence: `${entry.failed}/${entry.tasks} Tasks fehlgeschlagen`
      })
    }
    if (entry.needsWork > 0) {
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
    if (entry.failedAttempts > 0 && entry.tasks === 0) {
      learnings.push({
        ...base,
        provider: entry.provider,
        model: entry.model,
        kind: 'weakness',
        insight: 'Worker-Versuche scheiterten; Aufgaben wurden auf andere Slots umgeleitet',
        evidence: `${entry.failedAttempts} fehlgeschlagene(r) Versuch(e) in diesem Lauf`
      })
    }
  }

  // Comparative speed: only when at least two models finished successfully and
  // the fastest is clearly (≥30 %) ahead.
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
  stats: RetroModelStats[],
  status?: RunRetro['status']
): string {
  const tasks = stats.reduce((sum, entry) => sum + entry.tasks, 0)
  const succeeded = stats.reduce((sum, entry) => sum + entry.succeeded, 0)
  const label = status ? `Lauf ${RETRO_STATUS_LABEL[status]}` : 'Lauf ausgewertet'
  return `${label}: ${stats.length} Modell(e), ${succeeded}/${tasks} Tasks erfolgreich.`
}

/** Convert an orchestrator benchmark judgement into persistent learnings. */
export function benchmarkLearnings(
  record: Pick<BenchmarkRecord, 'task' | 'profileId'>,
  rankings: BenchmarkRanking[]
): NewModelLearning[] {
  const taskShort = record.task.replace(/\s+/g, ' ').trim().slice(0, 80)
  const learnings: NewModelLearning[] = []
  for (const ranking of rankings) {
    if (!ranking.provider) continue
    const base = {
      provider: ranking.provider,
      model: ranking.model ?? '',
      role: ranking.role,
      source: 'benchmark' as const,
      profileId: record.profileId,
      evidence: `Benchmark „${taskShort}“ · Score ${ranking.score}/10 · ${ranking.verdict}`.slice(0, 300)
    }
    for (const strength of ranking.strengths) {
      learnings.push({ ...base, kind: 'strength', insight: strength })
    }
    for (const weakness of ranking.weaknesses) {
      learnings.push({ ...base, kind: 'weakness', insight: weakness })
    }
    if (ranking.score >= 8 && ranking.strengths.length === 0) {
      learnings.push({ ...base, kind: 'strength', insight: `sehr gutes Benchmark-Ergebnis bei: ${taskShort}` })
    }
    if (ranking.score <= 3 && ranking.weaknesses.length === 0) {
      learnings.push({ ...base, kind: 'weakness', insight: `schwaches Benchmark-Ergebnis bei: ${taskShort}` })
    }
  }
  return learnings
}
