import { describe, expect, it } from 'vitest'
import {
  INITIAL_ANALYSIS_STATE,
  parseAnalysisState,
  parseBranchFiles
} from '../src/shared/retroAnalysis'

describe('retro analysis forward compatibility', () => {
  it('ignores new optional envelope, payload and state fields', () => {
    const parsed = parseBranchFiles([
      {
        path: 'runs/2026/07/future.json',
        json: {
          version: 1,
          exportedAt: 1,
          machineId: 'machine-1',
          kind: 'run-retro',
          optionalEnvelopeField: { introducedBy: 'track-a' },
          payload: {
            id: 'retro-future',
            createdAt: 1,
            modelStats: [],
            learnings: [],
            optionalRunField: { introducedBy: 'track-b' }
          }
        }
      }
    ])

    expect(parsed.skipped).toEqual([])
    expect(parsed.retros).toHaveLength(1)
    expect(parsed.retros[0]).toMatchObject({
      path: 'runs/2026/07/future.json',
      machineId: 'machine-1',
      retro: { id: 'retro-future', createdAt: 1 }
    })
    expect(
      parseAnalysisState({ ...INITIAL_ANALYSIS_STATE, optionalStateField: 'future' })
    ).toEqual(INITIAL_ANALYSIS_STATE)
  })
})
