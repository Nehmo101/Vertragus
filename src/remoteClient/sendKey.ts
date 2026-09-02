/**
 * Whether Return/Send on a send-hinted textarea should submit instead of
 * inserting a newline.
 *
 * `enterKeyHint="send"` is a LABEL. iOS Safari still inserts a newline in a
 * multiline textarea; preventDefault on `keydown` is not enough, because the
 * insertion often arrives as `beforeinput` (`insertLineBreak` /
 * `insertParagraph`) with no usable keydown at all. Shift+Enter is the one
 * path that must keep inserting a newline. IME composition Enter confirms the
 * candidate and must not submit.
 *
 * Two predicates, one per event: the caller preventDefaults and submits when
 * either says so. Start and goal fields keep `enterKeyHint="enter"` and never
 * consult these.
 */

export interface SendKeyFacts {
  key: string
  shiftKey: boolean
  /** `event.isComposing` / `nativeEvent.isComposing`. */
  isComposing: boolean
  /**
   * 229 = IME still composing on some engines, even when `isComposing` is
   * already false on the keydown that confirms the candidate.
   */
  keyCode?: number
}

export interface SendInputFacts {
  inputType: string
  isComposing: boolean
  /**
   * `InputEvent` has no `shiftKey`. The caller passes the last keydown's.
   * Absent/false is the iOS Send case, which often has no keydown at all.
   */
  shiftKey: boolean
}

/** IME keyCode used while a composition session is open. */
const IME_KEYCODE = 229

export function shouldSubmitSendKey(event: SendKeyFacts): boolean {
  if (event.isComposing || event.keyCode === IME_KEYCODE) return false
  return event.key === 'Enter' && !event.shiftKey
}

export function shouldSubmitSendInput(event: SendInputFacts): boolean {
  if (event.isComposing || event.shiftKey) return false
  return event.inputType === 'insertLineBreak' || event.inputType === 'insertParagraph'
}
