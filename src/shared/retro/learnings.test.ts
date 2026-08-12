import { describe, expect, it } from 'vitest'
import type { ModelLearning, NewModelLearning } from '../schema/retro'
import { learningKey, mergeModelLearnings, selectLearningTexts } from './learnings'

function learning(overrides: Partial<NewModelLearning> = {}): NewModelLearning {
  return {
    providerId: 'codex',
    model: 'gpt-5',
    kind: 'strength',
    insight: 'sehr stark bei UI-Aufgaben',
    source: 'orchestrator',
    ...overrides
  }
}

describe('mergeModelLearnings', () => {
  it('reinforces identical insights instead of duplicating them', () => {
    const first = mergeModelLearnings([], [learning()], 1_000)
    expect(first.all).toHaveLength(1)
    expect(first.applied[0]).toMatchObject({
      observations: 1,
      insight: 'sehr stark bei UI-Aufgaben'
    })

    const second = mergeModelLearnings(
      first.all,
      [learning({ insight: '  sehr   stark bei UI-Aufgaben ', evidence: 'Lauf 2' })],
      2_000
    )
    expect(second.all).toHaveLength(1)
    expect(second.all[0]).toMatchObject({ observations: 2, evidence: 'Lauf 2', updatedAt: 2_000 })
  })

  it('keeps different models, kinds and insights separate', () => {
    const { all } = mergeModelLearnings(
      [],
      [
        learning(),
        learning({ kind: 'weakness', insight: 'große Refactorings' }),
        learning({ model: 'gpt-5-mini' }),
        learning({ providerId: 'claude' })
      ],
      1_000
    )
    expect(all).toHaveLength(4)
    expect(new Set(all.map((entry) => learningKey(entry))).size).toBe(4)
  })

  it('skips additions whose insight is blank after normalization', () => {
    const { all, applied } = mergeModelLearnings([], [learning({ insight: '   ' })], 1_000)
    expect(all).toHaveLength(0)
    expect(applied).toHaveLength(0)
  })

  it('caps entries per model and kind, preferring confirmed insights', () => {
    let all: ModelLearning[] = []
    for (let i = 0; i < 20; i += 1) {
      all = mergeModelLearnings(all, [learning({ insight: `Erkenntnis ${i}` })], 1_000 + i).all
    }
    // Reinforce one of the oldest so it must survive the cap.
    all = mergeModelLearnings(all, [learning({ insight: 'Erkenntnis 0' })], 5_000).all
    const strengths = all.filter((entry) => entry.kind === 'strength')
    expect(strengths.length).toBeLessThanOrEqual(12)
    expect(strengths.some((entry) => entry.insight === 'Erkenntnis 0')).toBe(true)
  })
})

describe('selectLearningTexts', () => {
  it('returns top strengths and weaknesses for a provider/model', () => {
    const { all } = mergeModelLearnings(
      [],
      [
        learning(),
        learning({ kind: 'weakness', insight: 'langsame Massenänderungen' }),
        learning({ providerId: 'claude', insight: 'Architektur' })
      ],
      1_000
    )
    const texts = selectLearningTexts(all, 'codex', 'gpt-5')
    expect(texts.strengths).toEqual(['sehr stark bei UI-Aufgaben'])
    expect(texts.weaknesses).toEqual(['langsame Massenänderungen'])
    expect(selectLearningTexts(all, 'claude', 'irgendwas').strengths).toEqual([])
  })

  it('matches every model of the provider when asked with the empty default model', () => {
    const { all } = mergeModelLearnings(
      [],
      [learning(), learning({ model: 'gpt-5-mini', insight: 'flotte Kleinaufgaben' })],
      1_000
    )
    const texts = selectLearningTexts(all, 'codex', '')
    expect(texts.strengths).toHaveLength(2)
  })
})
