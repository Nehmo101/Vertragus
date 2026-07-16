/**
 * Pure analysis logic for the retro branch: parse exported envelopes, find
 * retros that were not analyzed yet, aggregate them deterministically and
 * define the synthesis contract (zod schemas) for the LLM step. Electron-free
 * so the CLI (scripts/retro-analyze.ts) and tests use it directly.
 */
// zod/v4-Subpath: der Structured-Output-Helper des Anthropic-SDK (zodOutputFormat)
// ist gegen die v4-API typisiert; zod 3.25+ liefert beide APIs aus.
import { z } from 'zod/v4'
import {
  learningKey,
  type BenchmarkRecord,
  type LearningKind,
  type LearningSource,
  type ModelLearning,
  type RetroModelStats,
  type RunRetro
} from './retro'

// ---------------------------------------------------------------------------
// Branch input
// ---------------------------------------------------------------------------

export interface BranchFile {
  /** Repo-relative path, e.g. runs/2026/07/retro-abc.json */
  path: string
  json: unknown
}

export const retroEnvelopeSchema = z.looseObject({
  version: z.number(),
  exportedAt: z.number(),
  machineId: z.string(),
  kind: z.enum(['run-retro', 'benchmark', 'learnings']),
  payload: z.unknown()
})

export interface ParsedRetro {
  path: string
  machineId: string
  retro: RunRetro
}

export interface ParsedBenchmark {
  path: string
  machineId: string
  record: BenchmarkRecord
}

export interface ParsedBranch {
  retros: ParsedRetro[]
  benchmarks: ParsedBenchmark[]
  learnings: ModelLearning[]
  /** Files that could not be parsed (reported, never fatal). */
  skipped: string[]
}

function isRunRetro(value: unknown): value is RunRetro {
  const retro = value as RunRetro
  return Boolean(
    retro &&
      typeof retro.id === 'string' &&
      typeof retro.createdAt === 'number' &&
      Array.isArray(retro.modelStats) &&
      Array.isArray(retro.learnings)
  )
}

function isBenchmarkRecord(value: unknown): value is BenchmarkRecord {
  const record = value as BenchmarkRecord
  return Boolean(
    record &&
      typeof record.id === 'string' &&
      typeof record.createdAt === 'number' &&
      Array.isArray(record.rankings)
  )
}

function isModelLearning(value: unknown): value is ModelLearning {
  const learning = value as ModelLearning
  return Boolean(
    learning &&
      typeof learning.insight === 'string' &&
      typeof learning.provider === 'string' &&
      typeof learning.kind === 'string'
  )
}

/**
 * Selbsttest-Läufe sind keine Modellbeobachtungen. Neuere Orca-Versionen
 * exportieren sie gar nicht mehr; Bestandsdaten auf dem Branch werden hier
 * ausgefiltert, damit sie nie in Overlay/Proposals einfließen.
 */
function isSelftestRetro(retro: RunRetro): boolean {
  return retro.workspaceSessionId === 'remote-selftest' ||
    retro.goal === 'Remote approval selftest'
}

/** Tolerant parse of all branch files: bad entries land in `skipped`. */
export function parseBranchFiles(files: BranchFile[]): ParsedBranch {
  const result: ParsedBranch = { retros: [], benchmarks: [], learnings: [], skipped: [] }
  for (const file of files) {
    const envelope = retroEnvelopeSchema.safeParse(file.json)
    if (!envelope.success) {
      result.skipped.push(file.path)
      continue
    }
    const { kind, payload, machineId } = envelope.data
    if (kind === 'run-retro' && isRunRetro(payload)) {
      if (isSelftestRetro(payload)) {
        result.skipped.push(file.path)
        continue
      }
      result.retros.push({ path: file.path, machineId, retro: payload })
    } else if (kind === 'benchmark' && isBenchmarkRecord(payload)) {
      result.benchmarks.push({ path: file.path, machineId, record: payload })
    } else if (kind === 'learnings' && Array.isArray(payload)) {
      result.learnings.push(...payload.filter(isModelLearning))
    } else {
      result.skipped.push(file.path)
    }
  }
  return result
}

// ---------------------------------------------------------------------------
// Analysis state (high-water mark)
// ---------------------------------------------------------------------------

export interface AnalysisState {
  version: 1
  lastAnalyzedAt: number
  /** Bounded memory of processed branch paths (idempotence, clock-skew safe). */
  analyzedPaths: string[]
  lastRunAt: number
}

export const INITIAL_ANALYSIS_STATE: AnalysisState = {
  version: 1,
  lastAnalyzedAt: 0,
  analyzedPaths: [],
  lastRunAt: 0
}

const MAX_ANALYZED_PATHS = 500
/** Late arrivals (offline queues) within this window are still analyzed. */
const LATE_ARRIVAL_GRACE_MS = 14 * 24 * 60 * 60_000

export function parseAnalysisState(json: unknown): AnalysisState {
  const parsed = z
    .object({
      version: z.number(),
      lastAnalyzedAt: z.number(),
      analyzedPaths: z.array(z.string()),
      lastRunAt: z.number()
    })
    .safeParse(json)
  if (!parsed.success) return INITIAL_ANALYSIS_STATE
  return { ...parsed.data, version: 1 }
}

/**
 * A file is new when its path was not processed yet and it is not older than
 * the watermark minus the late-arrival grace window. The bounded path list is
 * the primary filter; the watermark only fences off ancient re-uploads.
 */
export function collectNew<T extends { path: string }>(
  entries: T[],
  createdAtOf: (entry: T) => number,
  state: AnalysisState
): T[] {
  const analyzed = new Set(state.analyzedPaths)
  return entries.filter(
    (entry) =>
      !analyzed.has(entry.path) &&
      createdAtOf(entry) > state.lastAnalyzedAt - LATE_ARRIVAL_GRACE_MS
  )
}

export function nextState(
  state: AnalysisState,
  processedPaths: string[],
  now: number
): AnalysisState {
  const merged = [...state.analyzedPaths, ...processedPaths]
  const deduped = [...new Set(merged)]
  return {
    version: 1,
    lastAnalyzedAt: now,
    analyzedPaths: deduped.slice(-MAX_ANALYZED_PATHS),
    lastRunAt: now
  }
}

// ---------------------------------------------------------------------------
// Aggregation for the synthesis prompt
// ---------------------------------------------------------------------------

export interface AggregatedModelStats {
  provider: string
  model: string
  roles: string[]
  tasks: number
  succeeded: number
  needsWork: number
  failed: number
  stopped: number
  failedAttempts: number
  gateFindings: number
  runs: number
}

export interface AggregatedLearning {
  provider: string
  model: string
  role?: string
  kind: LearningKind
  insight: string
  evidence?: string
  source: LearningSource
  observations: number
}

export interface SynthesisInput {
  newRetroCount: number
  newBenchmarkCount: number
  machineCount: number
  stats: AggregatedModelStats[]
  learnings: AggregatedLearning[]
  benchmarkVerdicts: string[]
  currentOverlay: string
  existingProposalSlugs: string[]
}

const MAX_LEARNINGS_FOR_SYNTHESIS = 60
const MAX_BENCHMARK_VERDICTS = 30

function sumStats(retros: ParsedRetro[]): AggregatedModelStats[] {
  const groups = new Map<string, AggregatedModelStats & { runIds: Set<string> }>()
  for (const { retro } of retros) {
    for (const stats of retro.modelStats as RetroModelStats[]) {
      const key = `${stats.provider}|${stats.model.toLowerCase()}`
      let group = groups.get(key)
      if (!group) {
        group = {
          provider: stats.provider,
          model: stats.model,
          roles: [],
          tasks: 0,
          succeeded: 0,
          needsWork: 0,
          failed: 0,
          stopped: 0,
          failedAttempts: 0,
          gateFindings: 0,
          runs: 0,
          runIds: new Set()
        }
        groups.set(key, group)
      }
      group.tasks += stats.tasks
      group.succeeded += stats.succeeded
      group.needsWork += stats.needsWork
      group.failed += stats.failed
      group.stopped += stats.stopped
      group.failedAttempts += stats.failedAttempts
      group.gateFindings += stats.gateFindings
      group.runIds.add(retro.id)
      for (const role of stats.roles) {
        if (!group.roles.includes(role)) group.roles.push(role)
      }
    }
  }
  return [...groups.values()]
    .map(({ runIds, ...group }) => ({ ...group, runs: runIds.size }))
    .sort((a, b) => b.tasks - a.tasks)
}

/**
 * Dedupe learnings across machines/runs by insight key. The conservatism gate
 * is enforced HERE, not only in the prompt: a learning reaches the LLM only
 * with >= 2 observations, >= 2 independent occurrences, or a benchmark source.
 */
function gatedLearnings(all: ModelLearning[]): AggregatedLearning[] {
  const byKey = new Map<string, AggregatedLearning & { occurrences: number }>()
  for (const learning of all) {
    const key = learningKey(learning)
    const current = byKey.get(key)
    if (current) {
      current.observations = Math.max(current.observations, learning.observations ?? 1)
      current.occurrences += 1
      if (!current.evidence && learning.evidence) current.evidence = learning.evidence
    } else {
      byKey.set(key, {
        provider: learning.provider,
        model: learning.model,
        role: learning.role,
        kind: learning.kind,
        insight: learning.insight,
        evidence: learning.evidence,
        source: learning.source,
        observations: learning.observations ?? 1,
        occurrences: 1
      })
    }
  }
  // Generische auto-retro-Zähler auf 1/1-Basis sind Rauschen, auch wenn
  // wiederholte identische Läufe (z. B. Selbsttests) die observations
  // hochgezählt haben — sie beweisen keine Modelleigenschaft.
  const isGenericSingleTaskCounter = (entry: AggregatedLearning): boolean =>
    entry.source === 'auto-retro' &&
    /^fehleranfällig bei\b/i.test(entry.insight) &&
    /\b1\/1\b/.test(entry.evidence ?? '')
  return [...byKey.values()]
    .filter(
      (entry) =>
        entry.observations >= 2 || entry.occurrences >= 2 || entry.source === 'benchmark'
    )
    .filter((entry) => !isGenericSingleTaskCounter(entry))
    .sort((a, b) => b.observations - a.observations)
    .slice(0, MAX_LEARNINGS_FOR_SYNTHESIS)
    .map(({ occurrences: _occurrences, ...entry }) => entry)
}

function benchmarkVerdicts(benchmarks: ParsedBenchmark[]): string[] {
  const verdicts: string[] = []
  for (const { record } of benchmarks) {
    for (const ranking of record.rankings) {
      const model = `${ranking.provider ?? '?'}/${ranking.model || 'Standard'}`
      verdicts.push(
        `${model} · Score ${ranking.score}/10 · ${ranking.verdict} (Aufgabe: ${record.task.slice(0, 80)})`
      )
    }
  }
  return verdicts.slice(0, MAX_BENCHMARK_VERDICTS)
}

export function aggregateForSynthesis(input: {
  retros: ParsedRetro[]
  benchmarks: ParsedBenchmark[]
  learningsSnapshots: ModelLearning[]
  currentOverlay: string
  existingProposalSlugs: string[]
}): SynthesisInput {
  const allLearnings = [
    ...input.retros.flatMap(({ retro }) => retro.learnings),
    ...input.learningsSnapshots
  ]
  const machines = new Set([
    ...input.retros.map((entry) => entry.machineId),
    ...input.benchmarks.map((entry) => entry.machineId)
  ])
  return {
    newRetroCount: input.retros.length,
    newBenchmarkCount: input.benchmarks.length,
    machineCount: machines.size,
    stats: sumStats(input.retros),
    learnings: gatedLearnings(allLearnings),
    benchmarkVerdicts: benchmarkVerdicts(input.benchmarks),
    currentOverlay: input.currentOverlay,
    existingProposalSlugs: input.existingProposalSlugs
  }
}

// ---------------------------------------------------------------------------
// Synthesis output contract (validated LLM response)
// ---------------------------------------------------------------------------

export const synthesisProposalSchema = z.object({
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{2,59}$/),
  title: z.string().min(1).max(120),
  kind: z.enum(['prompt', 'tool', 'code', 'process']),
  motivation: z.string().min(1),
  evidence: z.array(z.string()).max(10),
  /** Self-contained Claude-Code brief, ready to execute against the repo. */
  prompt: z.string().min(1)
})

export const synthesisOutputSchema = z.object({
  /** Revised overlay (full replacement for overlay/learnings.md). */
  overlay: z.string().max(12_000),
  proposals: z.array(synthesisProposalSchema).max(3),
  /** Free-form analysis notes for the PR body. */
  notes: z.string()
})

export type SynthesisOutput = z.infer<typeof synthesisOutputSchema>
export type SynthesisProposal = z.infer<typeof synthesisProposalSchema>

// ---------------------------------------------------------------------------
// Proposal rendering
// ---------------------------------------------------------------------------

export function proposalFileName(dateIso: string, slug: string): string {
  return `proposals/${dateIso}-${slug}.md`
}

export function renderProposalMarkdown(
  proposal: SynthesisProposal,
  dateIso: string,
  sourceInfo: { retroCount: number; benchmarkCount: number }
): string {
  return [
    '---',
    'status: proposed',
    `created: ${dateIso}`,
    `kind: ${proposal.kind}`,
    `source-retros: ${sourceInfo.retroCount}`,
    `source-benchmarks: ${sourceInfo.benchmarkCount}`,
    '---',
    '',
    `# ${proposal.title}`,
    '',
    '## Kontext',
    '',
    proposal.motivation.trim(),
    '',
    '## Problem-Evidenz',
    '',
    ...(proposal.evidence.length > 0
      ? proposal.evidence.map((entry) => `- ${entry}`)
      : ['- (keine Einzelbelege angegeben)']),
    '',
    '## Auftrag',
    '',
    proposal.prompt.trim(),
    '',
    '## Abnahmekriterien',
    '',
    '- `pnpm run ci` läuft grün (Lint, Typecheck, Tests, Build).',
    '- Die Änderung adressiert nachweislich die oben belegte Schwäche.',
    ''
  ].join('\n')
}
