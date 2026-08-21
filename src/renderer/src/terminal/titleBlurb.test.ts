import { describe, expect, it } from 'vitest'
import { translator } from '../i18n'
import { metaBlurb } from './titleBlurb'

/** The authored language — the assertions read as the real UI reads. */
const t = translator('de')
const en = translator('en')

describe('metaBlurb', () => {
  it('reveals who the figure is when there is no task yet', () => {
    expect(metaBlurb(t, 'de', { name: 'Caronte', role: 'worker' }, undefined)).toMatch(/Fährmann/)
    expect(metaBlurb(t, 'de', { name: 'Caronte', role: 'worker' }, '   ')).toMatch(/Fährmann/)
    expect(metaBlurb(t, 'de', { name: 'Nobody', role: 'worker' }, undefined)).toBeUndefined()
    // The blurb follows the window's locale — bilingual data, not an i18n key.
    expect(metaBlurb(en, 'en', { name: 'Caronte', role: 'worker' }, undefined)).toMatch(/Ferryman/)
  })

  it('appends the agent\'s current task as its own paragraph', () => {
    const card = metaBlurb(t, 'de', { name: 'Caronte', role: 'worker' }, 'Parser-Bug fixen')
    expect(card).toMatch(/Fährmann/)
    expect(card).toContain('Aktuelle Aufgabe: Parser-Bug fixen')
    expect(metaBlurb(en, 'en', { name: 'Caronte', role: 'worker' }, 'Parser-Bug fixen')).toContain(
      'Current task: Parser-Bug fixen'
    )
    // A name outside the roster still gets a card once there is a task.
    expect(metaBlurb(t, 'de', { name: 'Nobody', role: 'worker' }, 'Docs schreiben')).toBe(
      'Aktuelle Aufgabe: Docs schreiben'
    )
  })

  it('labels the orchestrator\'s line as delegated, not as its own task', () => {
    const card = metaBlurb(t, 'de', { name: 'Virgilio', role: 'orchestrator' }, 'Parser-Bug fixen')
    expect(card).toMatch(/Führer/)
    expect(card).toContain('Zuletzt delegiert: Parser-Bug fixen')
    expect(
      metaBlurb(en, 'en', { name: 'Virgilio', role: 'orchestrator' }, 'Parser-Bug fixen')
    ).toContain('Last delegated: Parser-Bug fixen')
  })
})
