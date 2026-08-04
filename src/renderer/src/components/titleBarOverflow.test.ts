import { describe, expect, it } from 'vitest'
import i18n from '../i18n'
import { buildOverflowMenuItems, type OverflowMenuContext } from './titleBarOverflow'

// Labels are asserted against the German source copy, independent of the host locale.
const t = i18n.getFixedT('de')

const base: OverflowMenuContext = {
  language: 'de',
  theme: 'light',
  cliReadable: false,
  uiDensity: 'comfortable',
  updateVisible: false,
  updateLabel: 'Self-Update',
  updateDisabled: false,
  updateChannel: null,
  startMode: 'full'
}

describe('buildOverflowMenuItems', () => {
  it('liefert die festen Einträge in stabiler Reihenfolge', () => {
    const items = buildOverflowMenuItems(base, t)
    expect(items.map((item) => item.id)).toEqual([
      'language',
      'theme',
      'readable',
      'density',
      'startMode',
      'showRail'
    ])
  })

  it('zeigt den Startmodus als Detail', () => {
    expect(buildOverflowMenuItems(base, t).find((i) => i.id === 'startMode')?.detail).toBe(
      'Vollfenster'
    )
    expect(
      buildOverflowMenuItems({ ...base, startMode: 'rail' }, t).find((i) => i.id === 'startMode')
        ?.detail
    ).toBe('Rail')
  })

  it('mappt die Checked-Zustände auf den Store-Zustand', () => {
    const items = buildOverflowMenuItems({
      ...base,
      theme: 'dark',
      cliReadable: true,
      uiDensity: 'compact'
    }, t)
    const byId = new Map(items.map((item) => [item.id, item]))
    expect(byId.get('theme')?.checked).toBe(true)
    expect(byId.get('readable')?.checked).toBe(true)
    expect(byId.get('density')?.checked).toBe(true)
    expect(buildOverflowMenuItems(base, t).find((i) => i.id === 'density')?.checked).toBe(false)
  })

  it('zeigt die aktuelle Sprache als Detail', () => {
    expect(buildOverflowMenuItems(base, t).find((i) => i.id === 'language')?.detail).toBe('Deutsch')
    expect(
      buildOverflowMenuItems({ ...base, language: 'en' }, t).find((i) => i.id === 'language')?.detail
    ).toBe('English')
  })

  it('blendet Update-Items nur bei Bedarf ein und reicht disabled durch', () => {
    expect(buildOverflowMenuItems(base, t).some((i) => i.id === 'update')).toBe(false)
    expect(buildOverflowMenuItems(base, t).some((i) => i.id === 'updateChannel')).toBe(false)

    const items = buildOverflowMenuItems({
      ...base,
      updateVisible: true,
      updateLabel: 'Update installieren',
      updateDisabled: true,
      updateChannel: 'main'
    }, t)
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
      'startMode',
      'showRail',
      'update',
      'updateChannel'
    ])
  })
})
