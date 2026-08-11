import { describe, expect, it } from 'vitest'
import { ACCELERATOR_MODIFIERS, validateAccelerator } from './model'

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
      expect(validateAccelerator(value), value).toEqual({ ok: true })
    }
  })

  it('accepts every modifier Electron documents', () => {
    for (const modifier of ACCELERATOR_MODIFIERS) {
      expect(validateAccelerator(`${modifier}+K`), modifier).toEqual({ ok: true })
    }
  })

  it('is case-insensitive about modifiers and keys', () => {
    expect(validateAccelerator('cOnTrOl+aLt+v')).toEqual({ ok: true })
  })

  it('refuses an empty field with a reason', () => {
    expect(validateAccelerator('')).toMatchObject({ ok: false })
    expect(validateAccelerator('   ')).toMatchObject({ ok: false })
  })

  /**
   * The reason this is stricter than Electron: `globalShortcut.register('K')`
   * is legal and swallows K in every app on the machine.
   */
  it('refuses a bare key — a global hotkey needs a modifier', () => {
    const result = validateAccelerator('K')
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.reason).toContain('Modifier')
  })

  it('refuses a trailing plus that leaves no key', () => {
    const result = validateAccelerator('Control+')
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.reason).toContain('fehlt')
  })

  it('names the modifier it does not know', () => {
    const result = validateAccelerator('Strg+V')
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.reason).toContain('Strg')
  })

  it('names the key it does not know', () => {
    const result = validateAccelerator('Control+Ätsch')
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.reason).toContain('Ätsch')
  })

  it('refuses the same modifier twice', () => {
    const result = validateAccelerator('Control+Control+V')
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.reason).toContain('doppelt')
  })

  it('refuses an F-key Electron does not have', () => {
    expect(validateAccelerator('Control+F24')).toEqual({ ok: true })
    expect(validateAccelerator('Control+F25').ok).toBe(false)
    expect(validateAccelerator('Control+F0').ok).toBe(false)
  })
})
