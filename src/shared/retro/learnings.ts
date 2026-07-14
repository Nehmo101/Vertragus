import type { ModelLearning, NewModelLearning } from './contracts'

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
  existing: readonly ModelLearning[],
  additions: readonly NewModelLearning[],
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
  learnings: readonly ModelLearning[],
  provider: ModelLearning['provider'],
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
