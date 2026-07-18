const EDITABLE_TAGS = new Set(['INPUT', 'SELECT', 'TEXTAREA'])

type EventTargetLike = {
  tagName?: unknown
  isContentEditable?: unknown
  closest?: (selector: string) => unknown
}

function isEditableTarget(target: unknown): boolean {
  if (!target || typeof target !== 'object') return false
  const candidate = target as EventTargetLike
  if (typeof candidate.tagName === 'string' && EDITABLE_TAGS.has(candidate.tagName.toUpperCase())) {
    return true
  }
  if (candidate.isContentEditable === true) return true
  return (
    typeof candidate.closest === 'function' &&
    candidate.closest('[contenteditable]:not([contenteditable="false"])') !== null
  )
}

export function shouldIgnoreShortcutEvent(event: KeyboardEvent): boolean {
  if (event.defaultPrevented || event.repeat || event.isComposing || event.keyCode === 229) return true
  const path = typeof event.composedPath === 'function' ? event.composedPath() : [event.target]
  return path.some(isEditableTarget)
}
