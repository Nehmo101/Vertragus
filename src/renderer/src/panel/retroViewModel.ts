/**
 * Pure shaping for the panel's retro view: what the app learned about its
 * models (▲ strengths / ▼ weaknesses) and how the last runs went. All logic
 * lives here so it is testable without a DOM; RetroPanel.tsx only renders.
 */
import type { ModelLearning, RunRetro } from '../../../preload'
import type { Translate } from '../i18n'

export interface LearningRow {
  id: string
  marker: '▲' | '▼'
  insight: string
  /** "×3" once the same insight was re-confirmed; absent on first sight. */
  observationsLabel?: string
  /** Tooltip: the recorded evidence, when there is any. */
  title?: string
}

export interface LearningGroup {
  key: string
  /** "claude/sonnet", or "claude/<default-model word>" for an empty model. */
  label: string
  entries: LearningRow[]
}

/** At most this many learnings per provider/model — mirrors the prompt cap. */
const MAX_ROWS_PER_GROUP = 6

/**
 * Learnings grouped per provider/model: strengths first, then weaknesses,
 * each ranked by how often they were re-confirmed.
 */
export function groupLearnings(t: Translate, learnings: readonly ModelLearning[]): LearningGroup[] {
  const groups = new Map<string, { label: string; entries: ModelLearning[] }>()
  for (const learning of learnings) {
    const key = `${learning.providerId}|${learning.model.toLowerCase()}`
    const label = `${learning.providerId}/${learning.model || t('panel.retroDefaultModel')}`
    const group = groups.get(key) ?? { label, entries: [] }
    group.entries.push(learning)
    groups.set(key, group)
  }
  const rank = (entry: ModelLearning): number =>
    (entry.kind === 'strength' ? 1_000_000 : 0) + entry.observations
  return [...groups.entries()].map(([key, group]) => ({
    key,
    label: group.label,
    entries: group.entries
      .slice()
      .sort((a, b) => rank(b) - rank(a) || b.updatedAt - a.updatedAt)
      .slice(0, MAX_ROWS_PER_GROUP)
      .map((entry) => ({
        id: entry.id,
        marker: entry.kind === 'strength' ? '▲' : '▼',
        insight: entry.insight,
        ...(entry.observations > 1 ? { observationsLabel: `×${entry.observations}` } : {}),
        ...(entry.evidence ? { title: entry.evidence } : {})
      }))
  }))
}

export interface RunRow {
  id: string
  name: string
  dateLabel: string
  succeeded: number
  blocked: number
  failed: number
  /** Tooltip: the orchestrator's verdict, or the tally spelled out. */
  title: string
}

/** How many recent runs the panel shows. */
const MAX_RUN_ROWS = 5

export function runRows(
  t: Translate,
  retros: readonly RunRetro[],
  locale: string,
  limit = MAX_RUN_ROWS
): RunRow[] {
  const format = new Intl.DateTimeFormat(locale, { day: '2-digit', month: '2-digit' })
  return retros.slice(0, limit).map((retro) => {
    const tally = retro.stats.reduce(
      (sum, stats) => ({
        succeeded: sum.succeeded + stats.succeeded,
        blocked: sum.blocked + stats.blocked,
        failed: sum.failed + stats.failed
      }),
      { succeeded: 0, blocked: 0, failed: 0 }
    )
    return {
      id: retro.id,
      name: retro.workspaceName,
      dateLabel: format.format(new Date(retro.endedAt)),
      ...tally,
      title: retro.summary || t('panel.retroRunTally', tally)
    }
  })
}

/** True when there is nothing at all to show — the view renders one empty note. */
export function retroIsEmpty(
  retros: readonly RunRetro[] | null,
  learnings: readonly ModelLearning[] | null
): boolean {
  return retros !== null && learnings !== null && retros.length === 0 && learnings.length === 0
}
