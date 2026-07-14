import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ModelLearning } from '@shared/retro'
import { removeModelLearnings } from './retroStore'

const mockStore = vi.hoisted(() => ({
  values: new Map<string, unknown>(),
  writes: [] as Array<[string, unknown]>
}))

vi.mock('@main/config/store', () => ({
  getSetting: (key: string) => mockStore.values.get(key),
  setSetting: (key: string, value: unknown) => {
    mockStore.values.set(key, value)
    mockStore.writes.push([key, value])
  }
}))

function learning(overrides: Partial<ModelLearning>): ModelLearning {
  return {
    id: overrides.id ?? 'learning-1',
    provider: 'codex',
    model: 'gpt-5',
    kind: 'weakness',
    insight: 'fehleranfällig bei renderer-ui',
    evidence: '1/1 Tasks fehlgeschlagen',
    source: 'auto-retro',
    observations: 1,
    createdAt: 1_000,
    updatedAt: 1_000,
    ...overrides
  }
}

describe('removeModelLearnings', () => {
  beforeEach(() => {
    mockStore.values.clear()
    mockStore.writes.length = 0
  })

  it('removes only exact provider/model matches with a case-insensitive insight match', () => {
    const removable = learning({ id: 'remove-1' })
    const removableCaseVariant = learning({
      id: 'remove-2',
      insight: 'Renderer-UI ist FEHLERANFÄLLIG'
    })
    const differentProvider = learning({ id: 'keep-provider', provider: 'claude' })
    const differentModel = learning({ id: 'keep-model', model: 'GPT-5' })
    const differentInsight = learning({ id: 'keep-insight', insight: 'langsam bei renderer-ui' })
    mockStore.values.set('modelLearnings', [
      removable,
      removableCaseVariant,
      differentProvider,
      differentModel,
      differentInsight
    ])

    const removed = removeModelLearnings('codex', 'gpt-5', 'Fehleranfällig')

    expect(removed.map((entry) => entry.id)).toEqual(['remove-1', 'remove-2'])
    expect(mockStore.values.get('modelLearnings')).toEqual([
      differentProvider,
      differentModel,
      differentInsight
    ])
  })

  it('returns an empty result without rewriting the store when nothing matches', () => {
    mockStore.values.set('modelLearnings', [learning({})])

    expect(removeModelLearnings('codex', 'gpt-5', 'nicht enthalten')).toEqual([])
    expect(mockStore.writes).toEqual([])
  })
})
