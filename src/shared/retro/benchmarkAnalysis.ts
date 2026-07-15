import type { BenchmarkRanking, BenchmarkRecord, NewModelLearning } from './contracts'

/** Convert an orchestrator benchmark judgement into persistent learnings. */
export function benchmarkLearnings(
  record: Pick<BenchmarkRecord, 'task' | 'profileId'>,
  rankings: readonly BenchmarkRanking[]
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
