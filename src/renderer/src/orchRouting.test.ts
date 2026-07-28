import { describe, expect, it } from 'vitest'
import type { ModelLearning } from '@shared/retro'
import { buildRoutingInsights } from './orchRouting'

let seq = 0
function learning(partial: Partial<ModelLearning>): ModelLearning {
  seq += 1
  return {
    id: `l-${seq}`,
    provider: 'claude',
    model: 'opus',
    kind: 'strength',
    insight: `Insight ${seq}`,
    source: 'auto-retro',
    observations: 1,
    createdAt: 1,
    updatedAt: 1,
    ...partial
  }
}

describe('buildRoutingInsights', () => {
  it('returns nothing without slots or learnings', () => {
    expect(buildRoutingInsights(undefined, [learning({})])).toEqual([])
    expect(buildRoutingInsights([{ role: 'worker', provider: 'claude', model: 'opus' }], [])).toEqual([])
  })

  it('maps learned strengths/weaknesses onto the configured slot models', () => {
    const insights = buildRoutingInsights(
      [
        { role: 'frontend', provider: 'claude', model: 'opus' },
        { role: 'review', provider: 'claude', model: 'opus' },
        { role: 'backend', provider: 'codex', model: 'gpt-x' }
      ],
      [
        learning({ provider: 'claude', model: 'opus', kind: 'strength', insight: 'stark bei UI' }),
        learning({ provider: 'claude', model: 'opus', kind: 'weakness', insight: 'langsam bei Massenedits' }),
        learning({ provider: 'codex', model: 'gpt-x', kind: 'strength', insight: 'gut bei Tests' })
      ]
    )
    expect(insights).toHaveLength(2)
    const claude = insights.find((entry) => entry.provider === 'claude')
    expect(claude?.roles).toEqual(['frontend', 'review'])
    expect(claude?.learnedStrengths).toEqual(['stark bei UI'])
    expect(claude?.learnedWeaknesses).toEqual(['langsam bei Massenedits'])
    const codex = insights.find((entry) => entry.provider === 'codex')
    expect(codex?.learnedStrengths).toEqual(['gut bei Tests'])
    expect(codex?.learnedWeaknesses).toEqual([])
  })

  it('drops slots without matching learnings and non-orchestrated slots', () => {
    const insights = buildRoutingInsights(
      [
        { role: 'worker', provider: 'claude', model: 'opus' },
        { role: 'manual', provider: 'codex', model: 'gpt-x', orchestrated: false }
      ],
      [
        learning({ provider: 'codex', model: 'gpt-x', insight: 'gut bei Tests' }),
        learning({ provider: 'claude', model: 'sonnet', insight: 'anderes Modell' })
      ]
    )
    expect(insights).toEqual([])
  })

  it('dedupes learnings arriving from both the store and the last retro', () => {
    const insights = buildRoutingInsights(
      [{ role: 'worker', provider: 'claude', model: 'opus' }],
      [
        learning({ insight: 'Stark bei UI', observations: 3 }),
        learning({ insight: 'stark bei ui', observations: 1 }),
        learning({ insight: 'praezise Reviews', kind: 'strength' })
      ]
    )
    expect(insights).toHaveLength(1)
    expect(insights[0].learnedStrengths).toEqual(['Stark bei UI', 'praezise Reviews'])
  })

  it('caps each list at the given limit, best-confirmed first', () => {
    const insights = buildRoutingInsights(
      [{ role: 'worker', provider: 'claude', model: 'opus' }],
      [
        learning({ insight: 'a', observations: 1 }),
        learning({ insight: 'b', observations: 5 }),
        learning({ insight: 'c', observations: 3 })
      ],
      2
    )
    expect(insights[0].learnedStrengths).toEqual(['b', 'c'])
  })
})
