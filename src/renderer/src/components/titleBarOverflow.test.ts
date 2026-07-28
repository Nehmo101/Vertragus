import { describe, expect, it } from 'vitest'
import { buildOverflowMenuItems, type OverflowMenuContext } from './titleBarOverflow'

const base: OverflowMenuContext = {
  language: 'de',
  theme: 'light',
  cliReadable: false,
  uiDensity: 'comfortable',
  updateVisible: false,
  updateLabel: 'Self-Update',
  updateDisabled: false,
  updateChannel: null
}

describe('buildOverflowMenuItems', () => {
  it('liefert die vier festen Umschalter in stabiler Reihenfolge', () => {
    const items = buildOverflowMenuItems(base)
    expect(items.map((item) => item.id)).toEqual(['language', 'theme', 'readable', 'density'])
  })

  it('mappt die Checked-Zustände auf den Store-Zustand', () => {
    const items = buildOverflowMenuItems({
      ...base,
      theme: 'dark',
      cliReadable: true,
      uiDensity: 'compact'
    })
    const byId = new Map(items.map((item) => [item.id, item]))
    expect(byId.get('theme')?.checked).toBe(true)
    expect(byId.get('readable')?.checked).toBe(true)
    expect(byId.get('density')?.checked).toBe(true)
    expect(buildOverflowMenuItems(base).find((i) => i.id === 'density')?.checked).toBe(false)
  })

  it('zeigt die aktuelle Sprache als Detail', () => {
    expect(buildOverflowMenuItems(base).find((i) => i.id === 'language')?.detail).toBe('Deutsch')
    expect(
      buildOverflowMenuItems({ ...base, language: 'en' }).find((i) => i.id === 'language')?.detail
    ).toBe('English')
  })

  it('blendet Update-Items nur bei Bedarf ein und reicht disabled durch', () => {
    expect(buildOverflowMenuItems(base).some((i) => i.id === 'update')).toBe(false)
    expect(buildOverflowMenuItems(base).some((i) => i.id === 'updateChannel')).toBe(false)

    const items = buildOverflowMenuItems({
      ...base,
      updateVisible: true,
      updateLabel: 'Update installieren',
      updateDisabled: true,
      updateChannel: 'main'
    })
    const update = items.find((i) => i.id === 'update')
    expect(update?.label).toBe('Update installieren')
    expect(update?.disabled).toBe(true)
    expect(items.find((i) => i.id === 'updateChannel')?.detail).toBe('Main')
    // Umschalter zuerst, Update-Aktionen ans Ende.
    expect(items.map((i) => i.id)).toEqual([
      'language',
      'theme',
      'readable',
      'density',
      'update',
      'updateChannel'
    ])
  })
})
