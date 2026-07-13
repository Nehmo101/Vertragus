import { describe, expect, it } from 'vitest'
import { modelCatalogLabel, normalizeModelCatalog } from './modelCatalog'

describe('normalizeModelCatalog', () => {
  it('keeps structured live catalogues and their account state', () => {
    const catalog = normalizeModelCatalog({
      codex: {
        models: ['terra', 'sol', 'terra'],
        source: 'live',
        accountDependent: true
      }
    })

    expect(catalog.codex).toEqual({
      models: ['terra', 'sol'],
      source: 'live',
      accountDependent: true
    })
    expect(modelCatalogLabel('codex', catalog.codex)).toContain('terra/sol kontoabhängig')
  })

  it('treats legacy arrays as fallback suggestions', () => {
    const catalog = normalizeModelCatalog({ claude: ['sonnet', 'haiku'] })

    expect(catalog.claude.source).toBe('fallback')
    expect(catalog.claude.models).toEqual(['sonnet', 'haiku'])
    expect(modelCatalogLabel('claude', catalog.claude)).toContain('Presets kontoabhängig')
  })

  it('does not expose Cursor fallback guesses as verified choices', () => {
    const catalog = normalizeModelCatalog({ cursor: ['composer', 'auto'] })

    expect(catalog.cursor).toEqual({
      models: [],
      source: 'unavailable',
      accountDependent: true
    })
    expect(modelCatalogLabel('cursor', catalog.cursor)).toBe('Live-Liste nötig · kontoabhängig')
  })

  it('ignores malformed model data from the IPC boundary', () => {
    const catalog = normalizeModelCatalog({
      claude: { models: [' sonnet ', 7, '', 'sonnet'], source: 'live', accountDependent: 'yes' },
      cursor: { models: ['not-verified'], source: 'fallback', accountDependent: true }
    })

    expect(catalog.claude).toEqual({
      models: ['sonnet'],
      source: 'live',
      accountDependent: true
    })
    expect(catalog.cursor.models).toEqual([])
  })
})
