import { describe, expect, it } from 'vitest'
import type { OrcaTask } from './orchestrator'
import {
  analyzeRunRetro,
  benchmarkLearnings,
  deriveHeuristicLearnings,
  deriveModelStats,
  learningKey,
  mergeModelLearnings,
  selectLearningTexts,
  summarizeRetro,
  type ModelLearning,
  type NewModelLearning
} from './retro'

function task(overrides: Partial<OrcaTask>): OrcaTask {
  return {
    id: overrides.id ?? `t-${Math.random().toString(36).slice(2, 8)}`,
    title: 'Task',
    role: 'worker',
    status: 'success',
    createdAt: 1_000,
    finishedAt: 61_000,
    provider: 'codex',
    model: 'gpt-5',
    ...overrides
  }
}

function learning(overrides: Partial<NewModelLearning> = {}): NewModelLearning {
  return {
    provider: 'codex',
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
    expect(first.applied[0]).toMatchObject({ observations: 1, insight: 'sehr stark bei UI-Aufgaben' })

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
        learning({ provider: 'claude' })
      ],
      1_000
    )
    expect(all).toHaveLength(4)
    expect(new Set(all.map((entry) => learningKey(entry))).size).toBe(4)
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
        learning({ provider: 'claude', insight: 'Architektur' })
      ],
      1_000
    )
    const texts = selectLearningTexts(all, 'codex', 'gpt-5')
    expect(texts.strengths).toEqual(['sehr stark bei UI-Aufgaben'])
    expect(texts.weaknesses).toEqual(['langsame Massenänderungen'])
    expect(selectLearningTexts(all, 'claude', 'irgendwas').strengths).toEqual([])
  })
})

describe('deriveModelStats', () => {
  it('aggregates status, duration and usage per provider/model', () => {
    const stats = deriveModelStats([
      task({ id: 'a', usage: { tokensIn: 1_000, tokensOut: 500, costUsd: 0.5 } }),
      task({ id: 'b', status: 'needs-work', findings: [
        { gate: 'security', code: 'x', message: 'fix' }
      ] }),
      task({ id: 'c', provider: 'claude', model: 'sonnet', role: 'review', finishedAt: 31_000 })
    ])

    const codex = stats.find((entry) => entry.provider === 'codex')
    expect(codex).toMatchObject({
      model: 'gpt-5',
      tasks: 2,
      succeeded: 1,
      needsWork: 1,
      gateFindings: 1,
      tokensIn: 1_000,
      tokensOut: 500,
      costUsd: 0.5,
      avgDurationMs: 60_000
    })
    const claude = stats.find((entry) => entry.provider === 'claude')
    expect(claude).toMatchObject({ roles: ['review'], tasks: 1, succeeded: 1, avgDurationMs: 30_000 })
    expect(claude?.tokensIn).toBeUndefined()
  })

  it('attributes failed attempts to the model that failed, not the rescuer', () => {
    const stats = deriveModelStats([
      task({
        id: 'a',
        provider: 'cursor',
        model: 'composer',
        attempts: [
          { attempt: 1, provider: 'codex', model: 'gpt-5', status: 'error', startedAt: 1_000 },
          { attempt: 2, provider: 'cursor', model: 'composer', status: 'success', startedAt: 2_000 }
        ]
      })
    ])
    expect(stats.find((entry) => entry.provider === 'codex')).toMatchObject({
      tasks: 0,
      failedAttempts: 1
    })
    expect(stats.find((entry) => entry.provider === 'cursor')).toMatchObject({
      tasks: 1,
      succeeded: 1,
      failedAttempts: 0
    })
  })

  it('classifies terminal failures and failed attempts by their actual cause', () => {
    const infra = task({
      id: 'infra',
      status: 'error',
      failureKind: 'worker',
      attempts: [{
        attempt: 1,
        provider: 'codex',
        model: 'gpt-5',
        status: 'error',
        failureKind: 'worker',
        startedAt: 1_000,
        note: 'Provider is at capacity'
      }]
    }) as OrcaTask & { judgeReason?: string }
    infra.judgeReason = 'Der Provider bewertete den Worker-Abschluss als fehlgeschlagen.'

    const [stats] = deriveModelStats([
      infra,
      task({ id: 'cancelled', status: 'stopped', failureKind: 'cancelled' }),
      task({ id: 'model', status: 'error', failureKind: 'worker', note: 'Implementierung unvollständig' })
    ])

    expect(stats).toMatchObject({
      failed: 2,
      stopped: 1,
      failuresByKind: { infra: 1, cancelled: 1, model: 1 },
      failedAttempts: 1,
      failedAttemptsByKind: { infra: 1, cancelled: 0, model: 0 }
    })
  })
})

describe('deriveHeuristicLearnings', () => {
  it('derives reliability strengths and failure weaknesses from run data', () => {
    const learnings = deriveHeuristicLearnings(
      deriveModelStats([
        task({ id: 'a', role: 'frontend' }),
        task({ id: 'b', role: 'frontend' }),
        task({ id: 'c', provider: 'ollama', model: 'llama3', status: 'error' })
      ]),
      { profileId: 'p1' }
    )

    expect(learnings).toContainEqual(
      expect.objectContaining({
        provider: 'codex',
        kind: 'strength',
        insight: expect.stringContaining('zuverlässig im ersten Anlauf'),
        profileId: 'p1',
        source: 'auto-retro'
      })
    )
    expect(learnings).toContainEqual(
      expect.objectContaining({
        provider: 'ollama',
        kind: 'weakness',
        insight: expect.stringContaining('fehleranfällig')
      })
    )
  })

  it('does not derive a weakness from an infrastructure failure', () => {
    const learnings = deriveHeuristicLearnings(
      deriveModelStats([
        task({
          id: 'capacity',
          role: 'renderer-ui',
          status: 'error',
          failureKind: 'worker',
          note: 'Provider is at capacity'
        })
      ])
    )

    expect(learnings.some((entry) => entry.kind === 'weakness')).toBe(false)
  })

  it('continues to derive a weakness from a genuine model failure', () => {
    const learnings = deriveHeuristicLearnings(
      deriveModelStats([
        task({
          id: 'model-error',
          role: 'renderer-ui',
          status: 'error',
          failureKind: 'worker',
          note: 'Die Implementierung erfüllt die Akzeptanzkriterien nicht.'
        })
      ])
    )

    expect(learnings).toContainEqual(expect.objectContaining({
      kind: 'weakness',
      insight: expect.stringContaining('fehleranfällig bei renderer-ui')
    }))
  })

  it('does not treat a gate infrastructure error as a code finding', () => {
    const stats = deriveModelStats([
      task({
        id: 'gate-infra',
        role: 'quality',
        status: 'needs-work',
        failureKind: 'gate',
        findings: [{
          gate: 'quality',
          code: 'quality-gate-failed',
          message: 'ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY: eslint nicht gefunden'
        }]
      })
    ])
    const learnings = deriveHeuristicLearnings(stats)

    expect(stats[0].gateFindings).toBe(0)
    expect(learnings.some((entry) => entry.insight.includes('Quality-Gates'))).toBe(false)
  })

  it('keeps the quality-gate learning for a genuine code finding', () => {
    const learnings = deriveHeuristicLearnings(
      deriveModelStats([
        task({
          id: 'gate-code',
          role: 'quality',
          status: 'needs-work',
          failureKind: 'gate',
          findings: [{
            gate: 'quality',
            code: 'eslint-failed',
            message: 'src/main/example.ts: no-unused-vars'
          }]
        })
      ])
    )

    expect(learnings).toContainEqual(expect.objectContaining({
      kind: 'weakness',
      insight: expect.stringContaining('Quality-Gates erfordern Nacharbeit')
    }))
  })

  it('flags a clearly fastest model only with a real margin', () => {
    const fastVsSlow = deriveHeuristicLearnings(
      deriveModelStats([
        task({ id: 'a', createdAt: 0, finishedAt: 10_000 }),
        task({ id: 'b', provider: 'claude', model: 'sonnet', createdAt: 0, finishedAt: 100_000 })
      ])
    )
    expect(fastVsSlow).toContainEqual(
      expect.objectContaining({ provider: 'codex', insight: expect.stringContaining('schnellstes Modell') })
    )

    const similar = deriveHeuristicLearnings(
      deriveModelStats([
        task({ id: 'a', createdAt: 0, finishedAt: 90_000 }),
        task({ id: 'b', provider: 'claude', model: 'sonnet', createdAt: 0, finishedAt: 100_000 })
      ])
    )
    expect(similar.some((entry) => entry.insight.includes('schnellstes Modell'))).toBe(false)
  })
})

describe('summarizeRetro', () => {
  it('produces a truthful German one-liner', () => {
    const stats = deriveModelStats([task({ id: 'a' }), task({ id: 'b', status: 'error' })])
    expect(summarizeRetro(stats, 'needs-work')).toBe(
      'Lauf mit Nacharbeit: 1 Modell(e), 1/2 Tasks erfolgreich.'
    )
    expect(summarizeRetro([], undefined)).toContain('Lauf ausgewertet')
  })
})

describe('analyzeRunRetro', () => {
  it('returns the complete persistence-neutral analysis contract', () => {
    const analysis = analyzeRunRetro({
      tasks: [task({ id: 'a', role: 'frontend' }), task({ id: 'b', role: 'frontend' })],
      status: 'success',
      profileId: 'profile-1'
    })

    expect(analysis.summary).toBe('Lauf erfolgreich: 1 Modell(e), 2/2 Tasks erfolgreich.')
    expect(analysis.modelStats).toHaveLength(1)
    expect(analysis.learnings).toContainEqual(
      expect.objectContaining({
        provider: 'codex',
        kind: 'strength',
        profileId: 'profile-1',
        source: 'auto-retro'
      })
    )
  })
})

describe('benchmarkLearnings', () => {
  it('converts scored rankings into strengths/weaknesses with evidence', () => {
    const learnings = benchmarkLearnings(
      { task: 'Baue eine Settings-Seite', profileId: 'p1' },
      [
        {
          role: 'worker',
          provider: 'codex',
          model: 'gpt-5',
          score: 9,
          verdict: 'Sauber und vollständig',
          strengths: ['UI-Umsetzung'],
          weaknesses: []
        },
        {
          role: 'worker-2',
          provider: 'ollama',
          model: 'llama3',
          score: 2,
          verdict: 'Unvollständig',
          strengths: [],
          weaknesses: []
        },
        { role: 'unresolved', score: 5, verdict: 'ohne Provider', strengths: ['x'], weaknesses: [] }
      ]
    )

    expect(learnings).toContainEqual(
      expect.objectContaining({
        provider: 'codex',
        kind: 'strength',
        insight: 'UI-Umsetzung',
        source: 'benchmark',
        evidence: expect.stringContaining('Score 9/10')
      })
    )
    expect(learnings).toContainEqual(
      expect.objectContaining({
        provider: 'ollama',
        kind: 'weakness',
        insight: expect.stringContaining('schwaches Benchmark-Ergebnis')
      })
    )
    // Rankings without a resolvable provider must not produce broken entries.
    expect(learnings.some((entry) => entry.provider === undefined)).toBe(false)
  })
})
