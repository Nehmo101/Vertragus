import { describe, expect, it } from 'vitest'
import type { ModelLearning, RunRetro } from './retro'
import {
  aggregateForSynthesis,
  collectNew,
  INITIAL_ANALYSIS_STATE,
  nextState,
  parseAnalysisState,
  parseBranchFiles,
  proposalFileName,
  renderProposalMarkdown,
  synthesisOutputSchema,
  type AnalysisState,
  type BranchFile
} from './retroAnalysis'

const NOW = Date.UTC(2026, 6, 14, 12, 0, 0)

function learning(overrides: Partial<ModelLearning> = {}): ModelLearning {
  return {
    id: 'l1',
    provider: 'claude',
    model: 'opus',
    kind: 'strength',
    insight: 'stark bei UI-Aufgaben',
    source: 'auto-retro',
    observations: 1,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides
  } as ModelLearning
}

function retro(overrides: Partial<RunRetro> = {}): RunRetro {
  return {
    id: 'retro-1',
    planId: 'plan-1',
    goal: 'Ziel',
    summary: 'Lauf erfolgreich.',
    modelStats: [
      {
        provider: 'claude',
        model: 'opus',
        roles: ['frontend'],
        tasks: 3,
        succeeded: 3,
        needsWork: 0,
        failed: 0,
        stopped: 0,
        failedAttempts: 0,
        gateFindings: 0
      }
    ],
    learnings: [],
    createdAt: NOW,
    ...overrides
  } as RunRetro
}

function envelope(kind: string, payload: unknown, path: string): BranchFile {
  return {
    path,
    json: {
      version: 1,
      exportedAt: NOW,
      app: { name: 'orca-strator', version: '0.0.0' },
      machineId: 'abc123def456',
      kind,
      payload
    }
  }
}

describe('parseBranchFiles', () => {
  it('sorts envelopes by kind and skips broken files', () => {
    const parsed = parseBranchFiles([
      envelope('run-retro', retro(), 'runs/2026/07/retro-1.json'),
      envelope(
        'benchmark',
        { id: 'b1', benchmarkId: 'bench-1', task: 't', summary: 's', rankings: [], createdAt: NOW },
        'benchmarks/2026/07/b1.json'
      ),
      envelope('learnings', [learning()], 'learnings/abc123def456.json'),
      { path: 'runs/2026/07/kaputt.json', json: { not: 'an envelope' } },
      envelope('run-retro', { garbage: true }, 'runs/2026/07/garbage.json')
    ])
    expect(parsed.retros).toHaveLength(1)
    expect(parsed.benchmarks).toHaveLength(1)
    expect(parsed.learnings).toHaveLength(1)
    expect(parsed.skipped).toEqual(['runs/2026/07/kaputt.json', 'runs/2026/07/garbage.json'])
  })
})

describe('collectNew / state', () => {
  const state: AnalysisState = {
    version: 1,
    lastAnalyzedAt: NOW - 24 * 3600_000,
    analyzedPaths: ['runs/2026/07/alt.json'],
    lastRunAt: NOW - 24 * 3600_000
  }

  it('skips already analyzed paths regardless of timestamps', () => {
    const entries = [
      { path: 'runs/2026/07/alt.json', createdAt: NOW },
      { path: 'runs/2026/07/neu.json', createdAt: NOW }
    ]
    const fresh = collectNew(entries, (entry) => entry.createdAt, state)
    expect(fresh.map((entry) => entry.path)).toEqual(['runs/2026/07/neu.json'])
  })

  it('accepts late arrivals inside the grace window, rejects ancient files', () => {
    const entries = [
      { path: 'runs/2026/07/nachzuegler.json', createdAt: NOW - 3 * 24 * 3600_000 },
      { path: 'runs/2024/01/uralt.json', createdAt: NOW - 400 * 24 * 3600_000 }
    ]
    const fresh = collectNew(entries, (entry) => entry.createdAt, state)
    expect(fresh.map((entry) => entry.path)).toEqual(['runs/2026/07/nachzuegler.json'])
  })

  it('advances the state and bounds the path memory', () => {
    const many = Array.from({ length: 600 }, (_, i) => `runs/2026/07/r${i}.json`)
    const advanced = nextState(state, many, NOW)
    expect(advanced.lastAnalyzedAt).toBe(NOW)
    expect(advanced.analyzedPaths).toHaveLength(500)
    expect(advanced.analyzedPaths.at(-1)).toBe('runs/2026/07/r599.json')
    // Re-Run mit denselben Pfaden ist idempotent.
    const rerun = collectNew(
      many.map((path) => ({ path, createdAt: NOW })),
      (entry) => entry.createdAt,
      advanced
    )
    expect(rerun.filter((entry) => advanced.analyzedPaths.includes(entry.path))).toHaveLength(0)
  })

  it('falls back to the initial state for invalid json', () => {
    expect(parseAnalysisState({ bogus: true })).toEqual(INITIAL_ANALYSIS_STATE)
    expect(parseAnalysisState(undefined)).toEqual(INITIAL_ANALYSIS_STATE)
  })
})

describe('aggregateForSynthesis', () => {
  it('sums stats per model and enforces the conservatism gate', () => {
    const retros = [
      {
        path: 'runs/2026/07/r1.json',
        machineId: 'm1',
        retro: retro({
          id: 'r1',
          learnings: [
            learning({ insight: 'einmalige Beobachtung', observations: 1 }),
            learning({ insight: 'bestätigte Stärke', observations: 3 })
          ]
        })
      },
      {
        path: 'runs/2026/07/r2.json',
        machineId: 'm2',
        retro: retro({ id: 'r2', learnings: [learning({ insight: 'einmalige Beobachtung', observations: 1 })] })
      }
    ]
    const input = aggregateForSynthesis({
      retros,
      benchmarks: [
        {
          path: 'benchmarks/2026/07/b1.json',
          machineId: 'm1',
          record: {
            id: 'b1',
            benchmarkId: 'bench-1',
            task: 'CLI bauen',
            summary: 's',
            rankings: [
              {
                role: 'worker',
                provider: 'codex',
                model: 'gpt',
                score: 9,
                verdict: 'sehr sauber',
                strengths: [],
                weaknesses: []
              }
            ],
            createdAt: NOW
          }
        }
      ],
      learningsSnapshots: [
        learning({ insight: 'Benchmark-Erkenntnis', source: 'benchmark', observations: 1 })
      ],
      currentOverlay: '- Alte Regel',
      existingProposalSlugs: ['alte-idee']
    })

    expect(input.newRetroCount).toBe(2)
    expect(input.machineCount).toBe(2)
    expect(input.stats).toHaveLength(1)
    expect(input.stats[0]).toMatchObject({ provider: 'claude', tasks: 6, succeeded: 6, runs: 2 })

    const insights = input.learnings.map((entry) => entry.insight)
    // >= 2 Beobachtungen ODER >= 2 unabhängige Vorkommen ODER Benchmark-Quelle.
    expect(insights).toContain('bestätigte Stärke')
    expect(insights).toContain('einmalige Beobachtung')
    expect(insights).toContain('Benchmark-Erkenntnis')
    expect(input.benchmarkVerdicts[0]).toContain('codex/gpt · Score 9/10')
    expect(input.currentOverlay).toBe('- Alte Regel')
    expect(input.existingProposalSlugs).toEqual(['alte-idee'])
  })

  it('drops single-observation single-occurrence learnings', () => {
    const input = aggregateForSynthesis({
      retros: [
        {
          path: 'runs/2026/07/r1.json',
          machineId: 'm1',
          retro: retro({ learnings: [learning({ insight: 'nur einmal gesehen' })] })
        }
      ],
      benchmarks: [],
      learningsSnapshots: [],
      currentOverlay: '',
      existingProposalSlugs: []
    })
    expect(input.learnings).toHaveLength(0)
  })
})

describe('synthesis output contract', () => {
  it('validates a correct output and rejects out-of-contract ones', () => {
    const valid = synthesisOutputSchema.safeParse({
      overlay: '- Regel 1\n- Regel 2',
      proposals: [
        {
          slug: 'prompt-retry-regel',
          title: 'Retry-Regel schärfen',
          kind: 'prompt',
          motivation: 'Wiederholte Blind-Retries beobachtet.',
          evidence: ['3 Läufe mit identischen Retries'],
          prompt: 'Ändere src/main/orchestrator/orchestratorLaunch.ts …'
        }
      ],
      notes: 'Zusammenfassung.'
    })
    expect(valid.success).toBe(true)

    expect(
      synthesisOutputSchema.safeParse({
        overlay: '',
        proposals: [{ slug: 'Invalid Slug!', title: '', kind: 'prompt', motivation: '', evidence: [], prompt: '' }],
        notes: ''
      }).success
    ).toBe(false)
    expect(
      synthesisOutputSchema.safeParse({
        overlay: '',
        proposals: Array.from({ length: 4 }, (_, i) => ({
          slug: `zu-viele-${i}`,
          title: 't',
          kind: 'code',
          motivation: 'm',
          evidence: [],
          prompt: 'p'
        })),
        notes: ''
      }).success
    ).toBe(false)
  })
})

describe('renderProposalMarkdown', () => {
  it('renders front-matter and all sections', () => {
    const markdown = renderProposalMarkdown(
      {
        slug: 'prompt-retry-regel',
        title: 'Retry-Regel schärfen',
        kind: 'prompt',
        motivation: 'Wiederholte Blind-Retries.',
        evidence: ['3 Läufe betroffen'],
        prompt: 'Ändere …'
      },
      '2026-07-14',
      { retroCount: 5, benchmarkCount: 1 }
    )
    expect(markdown).toContain('status: proposed')
    expect(markdown).toContain('created: 2026-07-14')
    expect(markdown).toContain('kind: prompt')
    expect(markdown).toContain('## Kontext')
    expect(markdown).toContain('## Problem-Evidenz')
    expect(markdown).toContain('- 3 Läufe betroffen')
    expect(markdown).toContain('## Auftrag')
    expect(markdown).toContain('## Abnahmekriterien')
    expect(markdown).toContain('pnpm run ci')
    expect(proposalFileName('2026-07-14', 'prompt-retry-regel')).toBe(
      'proposals/2026-07-14-prompt-retry-regel.md'
    )
  })
})
