import { describe, expect, it } from 'vitest'
import { paneSearchKeyAction } from './paneSearch'

describe('paneSearchKeyAction', () => {
  it('maps Enter to next and Shift+Enter to previous', () => {
    expect(paneSearchKeyAction({ key: 'Enter', shiftKey: false })).toBe('next')
    expect(paneSearchKeyAction({ key: 'Enter', shiftKey: true })).toBe('previous')
  })

  it('maps Escape to close regardless of Shift', () => {
    expect(paneSearchKeyAction({ key: 'Escape', shiftKey: false })).toBe('close')
    expect(paneSearchKeyAction({ key: 'Escape', shiftKey: true })).toBe('close')
  })

  it('ignores every other key', () => {
    expect(paneSearchKeyAction({ key: 'a', shiftKey: false })).toBeNull()
    expect(paneSearchKeyAction({ key: 'Tab', shiftKey: false })).toBeNull()
    expect(paneSearchKeyAction({ key: 'ArrowDown', shiftKey: true })).toBeNull()
  })
})
