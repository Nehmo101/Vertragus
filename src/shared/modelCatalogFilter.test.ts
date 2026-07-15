import { describe, expect, it } from 'vitest'
import { filterModelCatalog } from './modelCatalogFilter'

describe('filterModelCatalog', () => {
  it('matches all query terms case-insensitively while preserving catalogue order', () => {
    const models = ['gpt-5.4-mini', 'Claude Opus 4.1', 'GPT-5.4', 'claude-sonnet']

    expect(filterModelCatalog(models, { query: '  GPT mini ' })).toEqual(['gpt-5.4-mini'])
    expect(filterModelCatalog(models, { query: 'CLAUDE' })).toEqual([
      'Claude Opus 4.1',
      'claude-sonnet'
    ])
  })

  it('removes excluded model ids case-insensitively', () => {
    expect(
      filterModelCatalog(['sonnet', 'OPUS', 'haiku'], {
        excludedModels: [' opus ', 'HAIKU']
      })
    ).toEqual(['sonnet'])
  })

  it('does not mutate the source catalogue and returns a fresh array', () => {
    const models = ['sonnet', 'opus'] as const
    const result = filterModelCatalog(models)

    expect(result).toEqual(models)
    expect(result).not.toBe(models)
    expect(models).toEqual(['sonnet', 'opus'])
  })

  it('ignores empty catalogue entries', () => {
    expect(filterModelCatalog(['', '   ', 'sonnet'])).toEqual(['sonnet'])
  })
})
