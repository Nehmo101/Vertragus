import { describe, expect, it } from 'vitest'
import i18n from './i18n'
import {
  defaultHandoffModel,
  modelCatalogLabel,
  normalizeModelCatalog,
  refreshedSuffix
} from './modelCatalog'

// The label test asserts the German source copy, independent of the host locale.
const t = i18n.getFixedT('de')

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
    expect(modelCatalogLabel(t, 'codex', catalog.codex)).toBe('Live · 2 Modelle · kontoabhängig')
  })

  it('treats ordinary legacy arrays as unverified fallback suggestions', () => {
    const catalog = normalizeModelCatalog({ codex: ['gpt-5.6-terra'] })

    expect(catalog.codex.source).toBe('fallback')
    expect(catalog.codex.models).toEqual(['gpt-5.6-terra'])
    expect(modelCatalogLabel(t, 'codex', catalog.codex)).toContain('nicht kontoverifiziert')
  })

  it('keeps Claude aliases visible for legacy and structured fallback responses', () => {
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
      models: ['sonnet', 'haiku'],
      source: 'fallback',
      accountDependent: true
    })
    expect(structured.claude).toMatchObject({
      models: ['opus'],
      source: 'fallback',
      accountDependent: true
    })
  })

  it('keeps Cursor fallback suggestions visible without marking them live', () => {
    const catalog = normalizeModelCatalog({ cursor: ['composer', 'auto'] })

    expect(catalog.cursor).toEqual({
      models: ['composer', 'auto'],
      source: 'fallback',
      accountDependent: true,
      detail: 'Kuratierte Vorschläge; Konto-Verfügbarkeit nicht verifiziert.'
    })
    expect(modelCatalogLabel(t, 'cursor', catalog.cursor)).toContain('Fallback · 2 Vorschläge')
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

  it('preserves mixed Claude catalogues and their provenance', () => {
    const catalog = normalizeModelCatalog({
      claude: {
        models: ['sonnet', 'opus', 'claude-fable-5'],
        source: 'mixed',
        accountDependent: true
      }
    })

    expect(catalog.claude.source).toBe('mixed')
    expect(modelCatalogLabel(t, 'claude', catalog.claude)).toContain('Live + Vorschläge')
  })
})

describe('family ordering at the IPC boundary', () => {
  it('puts a rolling alias directly in front of its pinned releases', () => {
    // The picker asked "why is there both fable and claude-fable-5?" — they are
    // one family, so they must arrive as one block, alias first.
    const catalog = normalizeModelCatalog({
      claude: {
        models: ['claude-fable-5', 'claude-opus-5', 'opus', 'fable'],
        source: 'live',
        accountDependent: true
      }
    })

    expect(catalog.claude.models).toEqual([
      'fable',
      'claude-fable-5',
      'opus',
      'claude-opus-5'
    ])
  })

  it('carries the discovery timestamp through and renders it', () => {
    const refreshedAt = Date.parse('2026-07-29T09:05:00Z')
    const catalog = normalizeModelCatalog({
      codex: { models: ['gpt-5.6-sol'], source: 'live', accountDependent: true, refreshedAt }
    })

    expect(catalog.codex.refreshedAt).toBe(refreshedAt)
    expect(refreshedSuffix(t, catalog.codex)).toContain('aktualisiert')
    expect(refreshedSuffix(t, { ...catalog.codex, refreshedAt: undefined })).toBe('')
  })

  it('ignores a non-numeric timestamp from the IPC boundary', () => {
    const catalog = normalizeModelCatalog({
      codex: { models: ['gpt-5.6-sol'], source: 'live', accountDependent: true, refreshedAt: 'now' }
    })
    expect(catalog.codex.refreshedAt).toBeUndefined()
  })
})

describe('defaultHandoffModel', () => {
  it('leaves cloud providers on CLI default and selects a required Ollama model', () => {
    const catalog = normalizeModelCatalog({
      claude: {
        models: ['claude-fable-5', 'fable'],
        source: 'live',
        accountDependent: true
      },
      copilot: {
        models: ['claude-sonnet-4.6'],
        source: 'fallback',
        accountDependent: true
      },
      ollama: {
        models: ['qwen2.5:32b', 'llava:7b'],
        source: 'live',
        accountDependent: false
      }
    })

    expect(defaultHandoffModel('claude', catalog.claude)).toBe('')
    expect(defaultHandoffModel('copilot', catalog.copilot)).toBe('')
    expect(defaultHandoffModel('ollama', catalog.ollama)).toBe('qwen2.5:32b')
  })
})
