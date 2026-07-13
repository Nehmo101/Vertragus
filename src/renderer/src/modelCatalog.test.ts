import { describe, expect, it } from 'vitest'
import {
  defaultHandoffModel,
  modelCatalogLabel,
  modelPresetAvailability,
  normalizeModelCatalog
} from './modelCatalog'

describe('normalizeModelCatalog', () => {
  it('keeps structured live catalogues and exact account model IDs', () => {
    const catalog = normalizeModelCatalog({
      codex: {
        models: ['gpt-5.6-terra', 'gpt-5.6-sol', 'gpt-5.6-terra'],
        source: 'live',
        accountDependent: true,
        detail: 'Codex account cache'
      }
    })

    expect(catalog.codex).toEqual({
      models: ['gpt-5.6-terra', 'gpt-5.6-sol'],
      source: 'live',
      accountDependent: true,
      detail: 'Codex account cache'
    })
    expect(modelCatalogLabel('codex', catalog.codex)).toBe('Live · 2 Modelle · kontoabhängig')
  })

  it('treats ordinary legacy arrays as unverified fallback suggestions', () => {
    const catalog = normalizeModelCatalog({ codex: ['gpt-5.6-terra'] })

    expect(catalog.codex.source).toBe('fallback')
    expect(catalog.codex.models).toEqual(['gpt-5.6-terra'])
    expect(modelCatalogLabel('codex', catalog.codex)).toContain('nicht kontoverifiziert')
  })

  it('never exposes Claude legacy or structured fallback guesses', () => {
    const legacy = normalizeModelCatalog({ claude: ['sonnet', 'haiku'] })
    const structured = normalizeModelCatalog({
      claude: {
        models: ['opus'],
        source: 'fallback',
        accountDependent: true,
        detail: 'Nicht verifiziert'
      }
    })

    expect(legacy.claude).toMatchObject({
      models: [],
      source: 'unavailable',
      accountDependent: true
    })
    expect(structured.claude).toMatchObject({
      models: [],
      source: 'unavailable',
      accountDependent: true
    })
  })

  it('does not expose Cursor fallback guesses as verified choices', () => {
    const catalog = normalizeModelCatalog({ cursor: ['composer', 'auto'] })

    expect(catalog.cursor).toEqual({
      models: [],
      source: 'unavailable',
      accountDependent: true,
      detail: 'Live-Liste von cursor-agent models erforderlich.'
    })
    expect(modelCatalogLabel('cursor', catalog.cursor)).toBe('Nicht verfügbar · kontoabhängig')
  })

  it('preserves explicit unavailable state and drops its model guesses', () => {
    const catalog = normalizeModelCatalog({
      cursor: {
        models: ['dead-guess'],
        source: 'unavailable',
        accountDependent: true,
        detail: 'Nicht angemeldet'
      }
    })

    expect(catalog.cursor).toMatchObject({
      models: [],
      source: 'unavailable',
      detail: 'Nicht angemeldet'
    })
  })

  it('ignores malformed model data from the IPC boundary', () => {
    const catalog = normalizeModelCatalog({
      claude: {
        models: [' fable ', 7, '', 'fable'],
        source: 'live',
        accountDependent: 'yes',
        detail: 42
      }
    })

    expect(catalog.claude).toEqual({
      models: ['fable'],
      source: 'live',
      accountDependent: true,
      detail: undefined
    })
  })
})

describe('modelPresetAvailability', () => {
  it('disables concrete preset targets missing from a live account catalogue', () => {
    const catalog = normalizeModelCatalog({
      claude: {
        models: ['fable', 'claude-fable-5'],
        source: 'live',
        accountDependent: true
      }
    })

    expect(modelPresetAvailability('claude', 'balanced', catalog.claude)).toMatchObject({
      available: false,
      target: 'sonnet'
    })
  })

  it('enables canonical Codex presets only when the live account catalogue contains them', () => {
    const live = normalizeModelCatalog({
      codex: {
        models: ['gpt-5.6-terra', 'gpt-5.6-sol'],
        source: 'live',
        accountDependent: true
      }
    })
    const fallback = normalizeModelCatalog({
      codex: {
        models: ['gpt-5.6-terra'],
        source: 'fallback',
        accountDependent: true
      }
    })

    expect(modelPresetAvailability('codex', 'balanced', live.codex)).toEqual({
      available: true,
      target: 'gpt-5.6-terra'
    })
    expect(modelPresetAvailability('codex', 'balanced', fallback.codex).available).toBe(false)
  })
})

describe('defaultHandoffModel', () => {
  it('uses only live account models and leaves fallback catalogues on CLI default', () => {
    const catalog = normalizeModelCatalog({
      claude: {
        models: ['claude-fable-5', 'fable'],
        source: 'live',
        accountDependent: true
      },
      copilot: {
        models: ['claude-sonnet-4.5'],
        source: 'fallback',
        accountDependent: true
      }
    })

    expect(defaultHandoffModel(catalog.claude)).toBe('claude-fable-5')
    expect(defaultHandoffModel(catalog.copilot)).toBe('')
  })
})
