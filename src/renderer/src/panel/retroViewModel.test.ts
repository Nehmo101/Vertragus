import { describe, expect, it } from 'vitest'
import type { ModelLearning, RunRetro } from '../../../preload'
import { translator } from '../i18n'
import { groupLearnings, retroIsEmpty, runRows } from './retroViewModel'

const t = translator('de')

function learning(overrides: Partial<ModelLearning> = {}): ModelLearning {
  return {
    id: `l-${Math.random().toString(36).slice(2, 8)}`,
    providerId: 'claude',
    model: 'sonnet',
    kind: 'strength',
    insight: 'stark bei UI',
    source: 'orchestrator',
    observations: 1,
    createdAt: 1_000,
    updatedAt: 1_000,
    ...overrides
  }
}

function retro(overrides: Partial<RunRetro> = {}): RunRetro {
  return {
    id: 'run-1',
    workspaceId: 'ws-1',
    workspaceName: 'Paradiso',
    profileId: 'p1',
    summary: '',
    stats: [
      {
        roleId: 'worker',
        providerId: 'claude',
        model: 'sonnet',
        started: 3,
        succeeded: 2,
        blocked: 1,
        failed: 0,
        unconfirmedExits: 0,
        stopped: 3
      }
    ],
    createdAt: 1_000,
    endedAt: 1_755_000_000_000,
    ...overrides
  }
}

describe('groupLearnings', () => {
  it('groups per provider/model with strengths ranked before weaknesses', () => {
    const groups = groupLearnings(t, [
      learning({ id: 'w', kind: 'weakness', insight: 'Migrationen', observations: 9 }),
      learning({ id: 's', insight: 'UI', observations: 2 }),
      learning({ id: 'other', providerId: 'codex', model: '' })
    ])

    expect(groups).toHaveLength(2)
    const claude = groups.find((group) => group.label === 'claude/sonnet')!
    expect(claude.entries.map((entry) => entry.id)).toEqual(['s', 'w'])
    expect(claude.entries[0]).toMatchObject({ marker: '▲', observationsLabel: '×2' })
    expect(claude.entries[1]).toMatchObject({ marker: '▼' })
    expect(claude.entries[1]!.observationsLabel).toBe('×9')
  })

  it('labels an empty model with the localized default-model word', () => {
    const groups = groupLearnings(t, [learning({ model: '' })])
    expect(groups[0]!.label).toBe(`claude/${t('panel.retroDefaultModel')}`)
  })

  it('caps each group at six rows and carries evidence as the tooltip', () => {
    const many = Array.from({ length: 9 }, (_, i) =>
      learning({ id: `l${i}`, insight: `Erkenntnis ${i}`, evidence: `Beleg ${i}` })
    )
    const groups = groupLearnings(t, many)
    expect(groups[0]!.entries).toHaveLength(6)
    expect(groups[0]!.entries[0]!.title).toMatch(/^Beleg /)
  })

  it('omits the observations label for a single sighting', () => {
    const groups = groupLearnings(t, [learning()])
    expect(groups[0]!.entries[0]!.observationsLabel).toBeUndefined()
  })
})

describe('runRows', () => {
  it('tallies the run stats and prefers the summary as the tooltip', () => {
    const rows = runRows(
      t,
      [
        retro({ summary: 'Sauberer Lauf.' }),
        retro({
          id: 'run-2',
          stats: [
            {
              roleId: 'worker',
              providerId: 'claude',
              model: 'sonnet',
              started: 1,
              succeeded: 0,
              blocked: 0,
              failed: 1,
              unconfirmedExits: 1,
              stopped: 1
            }
          ]
        })
      ],
      'de'
    )

    expect(rows[0]).toMatchObject({
      name: 'Paradiso',
      succeeded: 2,
      blocked: 1,
      failed: 0,
      title: 'Sauberer Lauf.'
    })
    // No summary: the tally, spelled out, becomes the tooltip.
    expect(rows[1]!.title).toBe(t('panel.retroRunTally', { succeeded: 0, blocked: 0, failed: 1 }))
    expect(rows[0]!.dateLabel).toMatch(/\d{2}\.\d{2}/)
  })

  it('shows at most five runs', () => {
    const many = Array.from({ length: 8 }, (_, i) => retro({ id: `run-${i}` }))
    expect(runRows(t, many, 'de')).toHaveLength(5)
  })
})

describe('retroIsEmpty', () => {
  it('is empty only once both lists loaded and both are empty', () => {
    expect(retroIsEmpty(null, null)).toBe(false)
    expect(retroIsEmpty([], null)).toBe(false)
    expect(retroIsEmpty([], [])).toBe(true)
    expect(retroIsEmpty([retro()], [])).toBe(false)
  })
})
