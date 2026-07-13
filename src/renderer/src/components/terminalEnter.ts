type TerminalKeyEvent = Pick<
  KeyboardEvent,
  'type' | 'key' | 'shiftKey' | 'ctrlKey' | 'altKey' | 'metaKey' | 'isComposing' | 'keyCode'
>

export type TerminalEnterAction = 'submit' | 'newline'

/**
 * Reserve unmodified Enter shortcuts for the agent prompt. IME composition and
 * modified shortcuts must continue through xterm unchanged.
 */
export function terminalEnterAction(event: TerminalKeyEvent): TerminalEnterAction | null {
  if (
    event.type !== 'keydown' ||
    event.key !== 'Enter' ||
    event.isComposing ||
    event.keyCode === 229 ||
    event.ctrlKey ||
    event.altKey ||
    event.metaKey
  ) {
    return null
  }

  return event.shiftKey ? 'newline' : 'submit'
}
