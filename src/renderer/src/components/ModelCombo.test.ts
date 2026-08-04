import { createElement, Fragment } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import ModelCombo, { comboOptions, comboVariantRows, moveHighlight } from './ModelCombo'

describe('comboOptions', () => {
  const models = ['claude-opus-5', 'claude-sonnet-4-6', 'claude-haiku-4-5']

  it('offers the complete catalogue while nothing was typed', () => {
    // The regression this component exists for: a saved model must not shrink
    // the suggestion list to itself (Chromium filters <datalist> that way).
    expect(comboOptions(models, null)).toEqual(models)
    expect(comboOptions(models, '  ')).toEqual(models)
  })

  it('narrows case-insensitively once the user types', () => {
    expect(comboOptions(models, 'HAIKU')).toEqual(['claude-haiku-4-5'])
    expect(comboOptions(models, '4-')).toEqual(['claude-sonnet-4-6', 'claude-haiku-4-5'])
    expect(comboOptions(models, 'gpt')).toEqual([])
  })
})

describe('comboVariantRows', () => {
  it('collapses dated snapshots into their base row and keeps them searchable', () => {
    const models = ['claude-sonnet-4-5', 'claude-sonnet-4-5-20250929', 'claude-opus-5']
    const rows = comboVariantRows(models, null)
    expect(rows.map((row) => row.id)).toEqual(['claude-sonnet-4-5', 'claude-opus-5'])
    expect(rows[0]!.snapshots).toEqual(['claude-sonnet-4-5-20250929'])
    // Typing a date still finds the base row via its folded snapshot.
    expect(comboVariantRows(models, '20250929').map((row) => row.id)).toEqual([
      'claude-sonnet-4-5'
    ])
  })

  it('collapses punctuation twins from different sources into one row', () => {
    const rows = comboVariantRows(['claude-sonnet-4.6', 'claude-sonnet-4-6'], null)
    expect(rows.map((row) => row.id)).toEqual(['claude-sonnet-4.6'])
  })
})

describe('moveHighlight', () => {
  it('wraps around both ends and starts at the matching edge', () => {
    expect(moveHighlight(-1, 1, 3)).toBe(0)
    expect(moveHighlight(-1, -1, 3)).toBe(2)
    expect(moveHighlight(2, 1, 3)).toBe(0)
    expect(moveHighlight(0, -1, 3)).toBe(2)
  })

  it('reports "nothing highlightable" for an empty list', () => {
    expect(moveHighlight(0, 1, 0)).toBe(-1)
  })
})

describe('ModelCombo markup', () => {
  it('renders a closed combobox with a toggle for the full list', () => {
    const markup = renderToStaticMarkup(
      createElement(ModelCombo, {
        className: 'select mono',
        id: 'orch-models',
        models: ['gpt-first', 'gpt-selected', 'gpt-last'],
        value: 'gpt-selected',
        onChange: vi.fn()
      })
    )

    expect(markup).toContain('value="gpt-selected"')
    expect(markup).toContain('role="combobox"')
    expect(markup).toContain('aria-controls="orch-models"')
    expect(markup).toContain('class="model-combo-toggle"')
    // Closed by default — the catalogue is a popup, not a permanent list.
    expect(markup).not.toContain('role="listbox"')
  })

  it('disables the toggle when the provider has no catalogue', () => {
    const markup = renderToStaticMarkup(
      createElement(ModelCombo, {
        className: 'select mono',
        id: 'orch-models',
        models: [],
        value: '',
        onChange: vi.fn()
      })
    )

    expect(markup).toMatch(/class="model-combo-toggle"[^>]*disabled/)
  })

  it('keeps one independent picker per subagent slot', () => {
    const models = ['sonnet', 'opus', 'haiku']
    const markup = renderToStaticMarkup(
      createElement(
        Fragment,
        null,
        createElement(ModelCombo, {
          className: 'slot-select-sm mono',
          id: 'slot-models-0',
          models,
          value: 'sonnet',
          onChange: vi.fn()
        }),
        createElement(ModelCombo, {
          className: 'slot-select-sm mono',
          id: 'slot-models-1',
          models,
          value: 'opus',
          onChange: vi.fn()
        })
      )
    )

    expect(markup.match(/class="model-combo-toggle"/g)).toHaveLength(2)
    expect(markup).toContain('id="slot-models-0-input"')
    expect(markup).toContain('id="slot-models-1-input"')
  })
})
