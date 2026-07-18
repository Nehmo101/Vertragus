import { createElement, Fragment } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import ModelCombo from './ModelCombo'

describe('ModelCombo', () => {
  it('offers the complete catalogue when a model is already selected', () => {
    const markup = renderToStaticMarkup(createElement(ModelCombo, {
      className: 'select mono',
      datalistId: 'orch-models',
      models: ['gpt-first', 'gpt-selected', 'gpt-last'],
      value: 'gpt-selected',
      onChange: vi.fn()
    }))

    expect(markup).toContain('value="gpt-selected"')
    expect(markup).toContain('<select class="model-combo-picker"')
    expect(markup).toContain('<option value="gpt-first">gpt-first</option>')
    expect(markup).toContain('<option value="gpt-selected">gpt-selected</option>')
    expect(markup).toContain('<option value="gpt-last">gpt-last</option>')
  })

  it('keeps separate complete pickers for every subagent slot', () => {
    const models = ['sonnet', 'opus', 'haiku']
    const markup = renderToStaticMarkup(createElement(
      Fragment,
      null,
      createElement(ModelCombo, {
        className: 'slot-select-sm mono', datalistId: 'slot-models-0', models,
        value: 'sonnet', onChange: vi.fn()
      }),
      createElement(ModelCombo, {
        className: 'slot-select-sm mono', datalistId: 'slot-models-1', models,
        value: 'opus', onChange: vi.fn()
      })
    ))

    expect(markup.match(/class="model-combo-picker"/g)).toHaveLength(2)
    expect(markup.match(/<option value="haiku">haiku<\/option>/g)).toHaveLength(2)
    expect(markup).toContain('id="slot-models-0"')
    expect(markup).toContain('id="slot-models-1"')
  })
})
