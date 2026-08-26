import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { shouldFocusTerminal } from './windowFocus'
import {
  canSubmitAnswer,
  isUserQuestion,
  overlayKeyAction,
  overlayShows,
  shouldAutofocusOverlay,
  shouldForwardKeyToPty,
  USER_QUESTION_AGENT_ID
} from './questionOverlay'

const question = {
  questionId: 'q-1',
  question: 'Use bcrypt?',
  agentId: 'worker-a',
  fromName: 'Caronte'
}

describe('the reserved ask_user addressee', () => {
  it('is the same string the host registry answers under', () => {
    const host = readFileSync(join(__dirname, '../../../main/mcp/types.ts'), 'utf8')
    const declaration = /export const USER_QUESTION_AGENT_ID = '([^']+)'/.exec(host)
    expect(declaration, 'USER_QUESTION_AGENT_ID not found in mcp/types.ts').not.toBeNull()
    expect(USER_QUESTION_AGENT_ID).toBe(declaration?.[1])
    expect(host).toContain("export const USER_QUESTION_AGENT_ID = 'user'")
  })
})

describe('overlayShows', () => {
  it('is hidden without a question, and after Escape on that questionId', () => {
    expect(overlayShows(null, null)).toBe(false)
    expect(overlayShows(question, null)).toBe(true)
    expect(overlayShows(question, 'q-1')).toBe(false)
    expect(overlayShows(question, 'other')).toBe(true)
  })

  it('reappears when a different question arrives after a dismiss', () => {
    expect(overlayShows({ ...question, questionId: 'q-2' }, 'q-1')).toBe(true)
  })
})

describe('overlayKeyAction', () => {
  it('submits on Enter, newlines on Shift+Enter, hides on Escape', () => {
    expect(overlayKeyAction({ key: 'Enter', shiftKey: false })).toBe('submit')
    expect(overlayKeyAction({ key: 'Enter', shiftKey: true })).toBeNull()
    expect(overlayKeyAction({ key: 'Escape', shiftKey: false })).toBe('hide')
    expect(overlayKeyAction({ key: 'a', shiftKey: false })).toBeNull()
  })
})

describe('keys must not reach the PTY', () => {
  it('forwards to xterm only while the overlay is hidden', () => {
    expect(shouldForwardKeyToPty(false)).toBe(true)
    expect(shouldForwardKeyToPty(true)).toBe(false)
  })

  it('wires TerminalApp so overlay keystrokes never go to the PTY', () => {
    const source = readFileSync(join(__dirname, 'TerminalApp.tsx'), 'utf8')
    // Self-check: if these markers vanish the overlay could start typing into
    // the TUI again, which does not release MCP waiters (H1).
    expect(source).toContain('shouldForwardKeyToPty')
    expect(source).toContain('overlayVisibleRef')
    expect(source).toContain('attachCustomKeyEventHandler')
    expect(source).toMatch(/if \(!shouldForwardKeyToPty\(overlayVisibleRef\.current\)\) return false/)
    expect(source).toContain('bridge.answerQuestion')
    expect(source).toContain('overlayKeyAction')
    expect(source).toContain("action === 'hide'")
    expect(source).toContain("action === 'submit'")
  })

  it('marks the overlay a no-drag region so title-bar chrome cannot steal keys', () => {
    const css = readFileSync(join(__dirname, 'terminal.css'), 'utf8')
    expect(css).toContain('.cli-question')
    expect(css).toContain('.cli-question-form')
    const overlay = css.slice(css.indexOf('.cli-question'))
    expect(overlay).toContain('-webkit-app-region: no-drag')
  })
})

describe('overlay autofocus must not steal OS focus', () => {
  it('autofocuses only when this window already has the OS keyboard', () => {
    expect(shouldAutofocusOverlay(true)).toBe(true)
    expect(shouldAutofocusOverlay(false)).toBe(false)
    expect(shouldAutofocusOverlay(true)).toBe(shouldFocusTerminal(true))
    expect(shouldAutofocusOverlay(false)).toBe(shouldFocusTerminal(false))
  })

  it('gates QuestionOverlay mount-focus and still moves in on window focus', () => {
    const source = readFileSync(join(__dirname, 'TerminalApp.tsx'), 'utf8')
    expect(source).toContain('shouldAutofocusOverlay(document.hasFocus())')
    expect(source).not.toMatch(
      /useEffect\(\(\) => \{\s*inputRef\.current\?\.focus\(\)\s*\}, \[\]\)/
    )
    expect(source).toContain("addEventListener('focus', onWindowFocus)")
    expect(source).toContain('textarea.cli-question-input')
    // Self-check: a regex that no longer sees the unconditional mount focus
    // would green the pin above for the wrong reason.
    expect(source).toContain('inputRef.current?.focus()')
  })
})

describe('submit', () => {
  it('refuses whitespace-only answers the way the panel field does', () => {
    expect(canSubmitAnswer('')).toBe(false)
    expect(canSubmitAnswer('  \n')).toBe(false)
    expect(canSubmitAnswer('Use bcrypt.')).toBe(true)
  })

  it('frames ask_user and leaves an agent question as the raw text', () => {
    expect(isUserQuestion({ agentId: USER_QUESTION_AGENT_ID })).toBe(true)
    expect(isUserQuestion({ agentId: 'worker-a' })).toBe(false)
  })
})
