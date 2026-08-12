import { describe, expect, it } from 'vitest'
import {
  modelLearningSchema,
  parseModelLearnings,
  parseRunRetros,
  runRetroSchema
} from './retro'

const validRetro = {
  id: 'run-1',
  workspaceId: 'ws-1',
  workspaceName: 'Limbo',
  profileId: 'profile-1',
  summary: 'Zwei Worker, ein Review, alles grün.',
  stats: [
    {
      roleId: 'worker',
      providerId: 'codex',
      model: 'gpt-5.6-sol',
      started: 2,
      succeeded: 2,
      blocked: 0,
      failed: 0,
      unconfirmedExits: 0,
      stopped: 2
    }
  ],
  createdAt: 1_000,
  endedAt: 2_000
}

const validLearning = {
  id: 'learning-1',
  providerId: 'codex',
  model: 'gpt-5.6-sol',
  kind: 'strength',
  insight: 'sehr stark bei UI-Aufgaben',
  source: 'orchestrator',
  observations: 1,
  createdAt: 1_000,
  updatedAt: 1_000
}

describe('runRetroSchema', () => {
  it('accepts a full retro and defaults the summary to empty', () => {
    const parsed = runRetroSchema.parse({ ...validRetro, summary: undefined })
    expect(parsed.summary).toBe('')
    expect(parsed.stats[0]).toMatchObject({ roleId: 'worker', succeeded: 2 })
  })

  it('rejects negative counters and unknown fields', () => {
    expect(
      runRetroSchema.safeParse({
        ...validRetro,
        stats: [{ ...validRetro.stats[0], failed: -1 }]
      }).success
    ).toBe(false)
    expect(runRetroSchema.safeParse({ ...validRetro, extra: true }).success).toBe(false)
  })

  it('defaults absent provider and model to empty strings in stats', () => {
    const parsed = runRetroSchema.parse({
      ...validRetro,
      stats: [{ ...validRetro.stats[0], providerId: undefined, model: undefined }]
    })
    expect(parsed.stats[0]).toMatchObject({ providerId: '', model: '' })
  })
})

describe('modelLearningSchema', () => {
  it('accepts a learning and defaults the model to the provider default', () => {
    const parsed = modelLearningSchema.parse({ ...validLearning, model: undefined })
    expect(parsed.model).toBe('')
  })

  it('rejects empty insights and unknown sources', () => {
    expect(modelLearningSchema.safeParse({ ...validLearning, insight: '  ' }).success).toBe(false)
    expect(modelLearningSchema.safeParse({ ...validLearning, source: 'benchmark' }).success).toBe(
      false
    )
  })
})

describe('fail-soft list parsers', () => {
  it('drops corrupt rows and keeps the rest', () => {
    const retros = parseRunRetros([validRetro, { id: 'broken' }, 42])
    expect(retros).toHaveLength(1)
    expect(retros[0]!.id).toBe('run-1')

    const learnings = parseModelLearnings([validLearning, { nope: true }])
    expect(learnings).toHaveLength(1)
  })

  it('keeps the first occurrence of a duplicate id', () => {
    const retros = parseRunRetros([validRetro, { ...validRetro, workspaceName: 'Inferno' }])
    expect(retros).toHaveLength(1)
    expect(retros[0]!.workspaceName).toBe('Limbo')
  })

  it('returns an empty list for a non-array', () => {
    expect(parseRunRetros(undefined)).toEqual([])
    expect(parseModelLearnings('nope')).toEqual([])
  })
})
