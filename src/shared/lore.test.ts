/**
 * Parity guard for the bilingual Commedia blurbs — the same discipline as the
 * renderer bundles (`i18n.test.ts`): every entry must carry BOTH languages,
 * and the English half must actually be English. Umlauts or eszett in an `en`
 * blurb are the reliable fingerprint of copy that was pasted, not translated.
 */
import { describe, expect, it } from 'vitest'
import { CAST, GUIDES, loreBlurb, type LoreCharacter } from './lore'
import { WORKSPACE_PLACES } from './workspaceNames'

const GERMAN_LETTERS = /[äöüÄÖÜß]/

const ROSTERS: ReadonlyArray<readonly [string, readonly LoreCharacter[]]> = [
  ['GUIDES', GUIDES],
  ['CAST', CAST],
  ['WORKSPACE_PLACES', WORKSPACE_PLACES]
]

describe('bilingual lore blurbs', () => {
  it('gives every figure and place a non-empty blurb in both languages', () => {
    for (const [roster, entries] of ROSTERS) {
      for (const entry of entries) {
        expect(entry.blurb.de.trim().length, `${roster}/${entry.name} de`).toBeGreaterThan(0)
        expect(entry.blurb.en.trim().length, `${roster}/${entry.name} en`).toBeGreaterThan(0)
      }
    }
  })

  it('leaves no German letters in the English blurbs', () => {
    const offenders = ROSTERS.flatMap(([roster, entries]) =>
      entries
        .filter((entry) => GERMAN_LETTERS.test(entry.blurb.en))
        .map((entry) => `${roster}/${entry.name}`)
    )
    expect(offenders, `German copy in en blurbs: ${offenders.join(', ')}`).toEqual([])
  })

  it('serves the language it is asked for, numbered clones included', () => {
    expect(loreBlurb('Caronte', 'de')).toMatch(/Fährmann/)
    expect(loreBlurb('Caronte', 'en')).toMatch(/Ferryman/)
    expect(loreBlurb('Caronte 2', 'en')).toBe(loreBlurb('Caronte', 'en'))
    expect(loreBlurb('Nobody', 'en')).toBeUndefined()
  })
})
