import { describe, expect, it } from 'vitest'
import { shouldSubmitComposer } from './CanvasComposer'

describe('CanvasComposer keyboard contract', () => {
  it('submits on Enter', () => {
    expect(shouldSubmitComposer('Enter', false)).toBe(true)
  })

  it('keeps a newline on Shift+Enter and ignores IME composition', () => {
    expect(shouldSubmitComposer('Enter', true)).toBe(false)
    expect(shouldSubmitComposer('Enter', false, true)).toBe(false)
    expect(shouldSubmitComposer('a', false)).toBe(false)
  })
})
