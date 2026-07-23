import { describe, expect, it } from 'vitest'
import { DEFAULT_PROFILE, workspaceProfileSchema } from './profile'
import { EFFICIENCY_SOLO_PROFILE } from './profilePresets'
import { recommendSoloModel } from './retro/soloModel'
import type { BenchmarkRecord, ModelLearning } from './retro/contracts'

describe('Efficiency-Solo profile schema', () => {
  it('parses the preset and keeps solo defaults off elsewhere', () => {
    expect(EFFICIENCY_SOLO_PROFILE.solo).toBe(true)
    expect(EFFICIENCY_SOLO_PROFILE.orchestrator).toBeUndefined()
    expect(EFFICIENCY_SOLO_PROFILE.agents).toHaveLength(1)
    expect(EFFICIENCY_SOLO_PROFILE.planner.maxParallel).toBe(1)
    // Older profiles without the flag default to solo:false.
    expect(workspaceProfileSchema.parse({ id: 'p', name: 'P' }).solo).toBe(false)
    expect(DEFAULT_PROFILE.solo).toBe(false)
  })

  it('rejects a solo profile with an orchestrator', () => {
    const result = workspaceProfileSchema.safeParse({
      ...EFFICIENCY_SOLO_PROFILE,
      orchestrator: DEFAULT_PROFILE.orchestrator
    })
    expect(result.success).toBe(false)
  })

  it('rejects a solo profile with more than one agent', () => {
    const slot = EFFICIENCY_SOLO_PROFILE.agents[0]
    expect(
      workspaceProfileSchema.safeParse({
        ...EFFICIENCY_SOLO_PROFILE,
        agents: [slot, { ...slot, role: 'zweiter' }]
      }).success
    ).toBe(false)
    expect(
      workspaceProfileSchema.safeParse({
        ...EFFICIENCY_SOLO_PROFILE,
        agents: [{ ...slot, count: 2 }]
      }).success
    ).toBe(false)
  })
})

describe('recommendSoloModel', () => {
  const learning = (overrides: Partial<ModelLearning>): ModelLearning => ({
    id: 'l1',
    provider: 'claude',
    model: 'sonnet',
    kind: 'strength',
    insight: 'stark bei Refactorings',
    source: 'orchestrator',
    observations: 1,
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  })
  const benchmark = (rankings: BenchmarkRecord['rankings']): BenchmarkRecord => ({
    id: 'b1',
    benchmarkId: 'bench-1',
    task: 'Refactor X',
    summary: 'ok',
    rankings,
    createdAt: 1
  })

  it('ranks by average benchmark score adjusted by learning balance', () => {
    const result = recommendSoloModel(
      [
        learning({ model: 'sonnet', kind: 'strength', observations: 2 }),
        learning({ id: 'l2', model: 'gpt', provider: 'codex', kind: 'weakness' })
      ],
      [
        benchmark([
          { role: 'a', provider: 'claude', model: 'sonnet', score: 8, verdict: 'gut', strengths: [], weaknesses: [] },
          { role: 'b', provider: 'codex', model: 'gpt', score: 9, verdict: 'sehr gut', strengths: [], weaknesses: [] }
        ])
      ]
    )
    expect(result[0].provider).toBe('codex')
    expect(result[0].score).toBeCloseTo(8.75)
    expect(result[1].provider).toBe('claude')
    expect(result[1].score).toBeCloseTo(8.5)
  })

  it('filters by provider and survives empty knowledge', () => {
    expect(recommendSoloModel([], [])).toEqual([])
    const filtered = recommendSoloModel(
      [learning({}), learning({ id: 'l2', provider: 'codex' })],
      [],
      'claude'
    )
    expect(filtered).toHaveLength(1)
    expect(filtered[0].provider).toBe('claude')
    // No benchmark data: neutral 5 plus the strength nudge.
    expect(filtered[0].score).toBeCloseTo(5.25)
  })
})
