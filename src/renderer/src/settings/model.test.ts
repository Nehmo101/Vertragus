import { describe, expect, it } from 'vitest'
import { translator } from '../i18n'
import { ACCELERATOR_MODIFIERS, validateAccelerator } from './model'

/** The authored language — the assertions read as the real UI reads. */
const t = translator('de')
const en = translator('en')

describe('validateAccelerator', () => {
  it('accepts the shipped default and the usual combinations', () => {
    for (const value of [
      'Control+Alt+V',
      'CommandOrControl+Shift+H',
      'Alt+Space',
      'Super+F12',
      'Ctrl+Shift+Escape',
      'Control+num5',
      'Control+Alt+Plus',
      'Control+/'
    ]) {
      expect(validateAccelerator(t, value), value).toEqual({ ok: true })
    }
  })

  it('accepts every modifier Electron documents', () => {
    for (const modifier of ACCELERATOR_MODIFIERS) {
      expect(validateAccelerator(t, `${modifier}+K`), modifier).toEqual({ ok: true })
    }
  })

  it('is case-insensitive about modifiers and keys', () => {
    expect(validateAccelerator(t, 'cOnTrOl+aLt+v')).toEqual({ ok: true })
  })

  it('refuses an empty field with a reason', () => {
    expect(validateAccelerator(t, '')).toMatchObject({ ok: false })
    expect(validateAccelerator(t, '   ')).toMatchObject({ ok: false })
  })

  /**
   * The reason this is stricter than Electron: `globalShortcut.register('K')`
   * is legal and swallows K in every app on the machine.
   */
  it('refuses a bare key — a global hotkey needs a modifier', () => {
    const result = validateAccelerator(t, 'K')
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.reason).toContain('Modifier')
  })

  it('refuses a trailing plus that leaves no key', () => {
    const result = validateAccelerator(t, 'Control+')
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.reason).toContain('fehlt')
  })

  it('names the modifier it does not know', () => {
    const result = validateAccelerator(t, 'Strg+V')
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.reason).toContain('Strg')
  })

  it('names the key it does not know', () => {
    const result = validateAccelerator(t, 'Control+Ätsch')
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.reason).toContain('Ätsch')
  })

  it('refuses the same modifier twice', () => {
    const result = validateAccelerator(t, 'Control+Control+V')
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.reason).toContain('doppelt')
  })

  it('answers in the language it is handed', () => {
    const result = validateAccelerator(en, 'Control+Control+V')
    expect(result.ok === false && result.reason).toBe('“Control” appears twice in the hotkey.')
    const empty = validateAccelerator(en, '   ')
    expect(empty.ok === false && empty.reason).toBe('Please enter a hotkey.')
  })

  it('refuses an F-key Electron does not have', () => {
    expect(validateAccelerator(t, 'Control+F24')).toEqual({ ok: true })
    expect(validateAccelerator(t, 'Control+F25').ok).toBe(false)
    expect(validateAccelerator(t, 'Control+F0').ok).toBe(false)
  })
})
