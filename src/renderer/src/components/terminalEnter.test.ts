import { describe, expect, it } from 'vitest'
import { terminalEnterAction, terminalEnterData } from './terminalEnter'

const enter = (overrides: Partial<KeyboardEvent> = {}): KeyboardEvent =>
  ({ type: 'keydown', key: 'Enter', ...overrides }) as KeyboardEvent

describe('terminalEnterAction', () => {
  it('submits on unmodified Enter', () => {
    expect(terminalEnterAction(enter())).toBe('submit')
  })

  it('inserts a line break on Shift+Enter', () => {
    expect(terminalEnterAction(enter({ shiftKey: true }))).toBe('newline')
  })

  it('maps submit and multiline actions to distinct PTY bytes', () => {
    expect(terminalEnterData(enter())).toBe('\r')
    expect(terminalEnterData(enter({ shiftKey: true }))).toBe('\n')
    expect(terminalEnterData(enter({ ctrlKey: true }))).toBeNull()
  })

  it.each([
    enter({ isComposing: true }),
    enter({ keyCode: 229 }),
    enter({ ctrlKey: true }),
    enter({ altKey: true }),
    enter({ metaKey: true }),
    enter({ key: 'N' }),
    enter({ type: 'keyup' })
  ])('does not intercept IME, modifier, or non-keydown events', (event) => {
    expect(terminalEnterAction(event)).toBeNull()
  })
})
