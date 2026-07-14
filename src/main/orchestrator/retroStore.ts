/**
 * Persistent retro / model-learning / benchmark store (electron-store settings).
 *
 * Learnings are the feedback channel that makes the orchestrator stronger over
 * time: every retro and benchmark merges its insights here, list_subagents and
 * the profile suggestion flow read them back.
 */
import { getSetting, setSetting } from '@main/config/store'
import {
  mergeModelLearnings,
  selectLearningTexts,
  type BenchmarkRecord,
  type ModelLearning,
  type NewModelLearning,
  type RunRetro
} from '@shared/retro'
import type { AgentProviderId } from '@shared/providers'

const RETROS_KEY = 'runRetros'
const LEARNINGS_KEY = 'modelLearnings'
const BENCHMARKS_KEY = 'benchmarkRecords'
const MAX_RETROS = 50
const MAX_BENCHMARKS = 50

function readArray<T>(key: string): T[] {
  const raw = getSetting<unknown>(key)
  return Array.isArray(raw) ? (raw as T[]) : []
}

export function listRunRetros(profileId?: string): RunRetro[] {
  const retros = readArray<RunRetro>(RETROS_KEY).filter(
    (retro) => retro && typeof retro.id === 'string'
  )
  const filtered = profileId ? retros.filter((retro) => retro.profileId === profileId) : retros
  return [...filtered].sort((a, b) => b.createdAt - a.createdAt)
}

/** Insert or update (by id) one retro; the history stays bounded. */
export function recordRunRetro(retro: RunRetro): void {
  const retros = readArray<RunRetro>(RETROS_KEY).filter(
    (entry) => entry && typeof entry.id === 'string' && entry.id !== retro.id
  )
  retros.push(retro)
  retros.sort((a, b) => b.createdAt - a.createdAt)
  setSetting(RETROS_KEY, retros.slice(0, MAX_RETROS))
}

export function listModelLearnings(): ModelLearning[] {
  return readArray<ModelLearning>(LEARNINGS_KEY).filter(
    (entry) => entry && typeof entry.insight === 'string' && typeof entry.provider === 'string'
  )
}

/** Merge new learnings (dedup + reinforce) and return the applied entries. */
export function recordModelLearnings(additions: NewModelLearning[]): ModelLearning[] {
  if (additions.length === 0) return []
  const merged = mergeModelLearnings(listModelLearnings(), additions)
  setSetting(LEARNINGS_KEY, merged.all)
  return merged.applied
}

/** Top learned strengths/weaknesses for one provider/model (router surface). */
export function learningsForModel(
  provider: AgentProviderId,
  model: string
): { strengths: string[]; weaknesses: string[] } {
  return selectLearningTexts(listModelLearnings(), provider, model)
}

export function listBenchmarkRecords(profileId?: string): BenchmarkRecord[] {
  const records = readArray<BenchmarkRecord>(BENCHMARKS_KEY).filter(
    (record) => record && typeof record.id === 'string'
  )
  const filtered = profileId ? records.filter((record) => record.profileId === profileId) : records
  return [...filtered].sort((a, b) => b.createdAt - a.createdAt)
}

export function recordBenchmarkRecord(record: BenchmarkRecord): void {
  const records = readArray<BenchmarkRecord>(BENCHMARKS_KEY).filter(
    (entry) => entry && typeof entry.id === 'string' && entry.id !== record.id
  )
  records.push(record)
  records.sort((a, b) => b.createdAt - a.createdAt)
  setSetting(BENCHMARKS_KEY, records.slice(0, MAX_BENCHMARKS))
}
