import { useEffect, useRef, type ReactNode, type RefObject } from 'react'
import { useEscapeToClose } from './useEscapeToClose'
import { FOCUSABLE_SELECTOR, trapTabKey } from './focusTrap'
import styles from './Modal.module.css'

export type ModalSize = 'md' | 'sm'

export interface ModalProps {
  /** Called on scrim click and Escape (subject to the closeOn* flags). */
  onClose(): void
  children: ReactNode
  /** Extra classes for the dialog surface, e.g. a per-modal width class. */
  className?: string
  /** Width preset of the default dialog chrome: 'md' = 640px, 'sm' = 520px. */
  size?: ModalSize
  /** id of the element that titles the dialog (aria-labelledby). */
  labelledBy?: string
  /** Plain-text label when no titling element exists (aria-label). */
  label?: string
  /** Close when the scrim is clicked (default true). */
  closeOnScrim?: boolean
  /** Close on Escape (default true). */
  closeOnEscape?: boolean
  /** Focused on open; falls back to the first focusable element, then the dialog. */
  initialFocus?: RefObject<HTMLElement>
  /**
   * Opt out of the default centered-modal chrome: no centering wrapper and no
   * default module/global classes — `className`/`scrimClassName` are used
   * as-is. For popover-styled dialogs (e.g. the speech settings). Behavior
   * (Escape, focus trap, scrim click, ARIA) stays identical.
   */
  unstyled?: boolean
  /** Scrim classes; defaults to the modal scrim chrome unless `unstyled`. */
  scrimClassName?: string
}

/**
 * Shared modal primitive: scrim, one central Escape handler, focus trap
 * (Tab cycles inside; focus returns to the trigger on close) and dialog ARIA.
 * Mounting the component opens the modal — conditionally render it.
 */
export default function Modal({
  onClose,
  children,
  className,
  size = 'md',
  labelledBy,
  label,
  closeOnScrim = true,
  closeOnEscape = true,
  initialFocus,
  unstyled = false,
  scrimClassName
}: ModalProps): JSX.Element {
  const dialogRef = useRef<HTMLDivElement>(null)

  useEscapeToClose(onClose, { enabled: closeOnEscape })

  // Restore focus to the previously focused (trigger) element on close.
  useEffect(() => {
    const previous = document.activeElement
    return () => {
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus()
    }
  }, [])

  // Move focus into the dialog on open — unless something inside (e.g. an
  // autoFocus field rendered by the consumer) already claimed it.
  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog || dialog.contains(document.activeElement)) return
    const target =
      initialFocus?.current ?? dialog.querySelector<HTMLElement>(FOCUSABLE_SELECTOR) ?? dialog
    target.focus()
  }, [initialFocus])

  // Keep Tab / Shift+Tab cycling inside the dialog.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const dialog = dialogRef.current
      if (dialog) trapTabKey(event, dialog, document.activeElement)
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [])

  const dialogClasses = unstyled
    ? className
    : [styles.dialog, size === 'sm' ? styles.sm : undefined, 'modal', className]
        .filter(Boolean)
        .join(' ')
  const scrimClasses = scrimClassName ?? (unstyled ? undefined : `${styles.scrim} modal-scrim`)

  const content = (
    <>
      <div
        className={scrimClasses}
        onClick={() => {
          if (closeOnScrim) onClose()
        }}
      />
      <div
        ref={dialogRef}
        className={dialogClasses}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        aria-label={label}
        tabIndex={-1}
      >
        {children}
      </div>
    </>
  )

  if (unstyled) return content
  return <div className={`${styles.wrap} modal-wrap`}>{content}</div>
}
