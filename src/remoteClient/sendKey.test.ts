import { describe, expect, it } from 'vitest'
import { shouldSubmitSendInput, shouldSubmitSendKey } from './sendKey'

describe('shouldSubmitSendKey — keydown', () => {
  it('submits Return/Send without a modifier', () => {
    expect(shouldSubmitSendKey({ key: 'Enter', shiftKey: false, isComposing: false })).toBe(true)
  })

  it('keeps Shift+Enter as a newline', () => {
    expect(shouldSubmitSendKey({ key: 'Enter', shiftKey: true, isComposing: false })).toBe(false)
  })

  it('does not submit while an IME is composing', () => {
    expect(shouldSubmitSendKey({ key: 'Enter', shiftKey: false, isComposing: true })).toBe(false)
    expect(
      shouldSubmitSendKey({ key: 'Enter', shiftKey: false, isComposing: false, keyCode: 229 })
    ).toBe(false)
  })

  it('ignores every other key', () => {
    expect(shouldSubmitSendKey({ key: 'a', shiftKey: false, isComposing: false })).toBe(false)
    expect(shouldSubmitSendKey({ key: 'Tab', shiftKey: false, isComposing: false })).toBe(false)
    expect(shouldSubmitSendKey({ key: 'Escape', shiftKey: false, isComposing: false })).toBe(false)
  })
})

describe('shouldSubmitSendInput — beforeinput', () => {
  it('turns insertLineBreak and insertParagraph into a submit', () => {
    expect(
      shouldSubmitSendInput({ inputType: 'insertLineBreak', isComposing: false, shiftKey: false })
    ).toBe(true)
    expect(
      shouldSubmitSendInput({ inputType: 'insertParagraph', isComposing: false, shiftKey: false })
    ).toBe(true)
  })

  it('keeps Shift+Enter as a newline even when the engine reports insertLineBreak', () => {
    // InputEvent has no shiftKey; the caller forwards the last keydown's.
    expect(
      shouldSubmitSendInput({ inputType: 'insertLineBreak', isComposing: false, shiftKey: true })
    ).toBe(false)
    expect(
      shouldSubmitSendInput({ inputType: 'insertParagraph', isComposing: false, shiftKey: true })
    ).toBe(false)
  })

  it('does not submit while an IME is composing', () => {
    expect(
      shouldSubmitSendInput({ inputType: 'insertLineBreak', isComposing: true, shiftKey: false })
    ).toBe(false)
  })

  it('ignores ordinary text insertion and edits', () => {
    expect(
      shouldSubmitSendInput({ inputType: 'insertText', isComposing: false, shiftKey: false })
    ).toBe(false)
    expect(
      shouldSubmitSendInput({
        inputType: 'insertCompositionText',
        isComposing: true,
        shiftKey: false
      })
    ).toBe(false)
    expect(
      shouldSubmitSendInput({
        inputType: 'deleteContentBackward',
        isComposing: false,
        shiftKey: false
      })
    ).toBe(false)
  })
})
