import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  loreTipPlacement,
  LORE_TIP_OPEN_DELAY_MS,
  type LoreTipPlacement
} from './loreTipPlacement'
import './loreTip.css'

interface Props {
  /** The name itself — "Limbo", "Fortuna". Also the card's heading. */
  name: string
  /** The one-line blurb. No blurb, no card: the name renders bare. */
  blurb?: string
  /** Class of the inline trigger, so callers keep their own typography. */
  className?: string
}

/**
 * A Commedia name with the mini description that pops up when you point at it.
 *
 * Restored from the old repo, where hovering "Limbo" or "Fortuna" told you what
 * you were looking at. The blurbs survived the rewrite (they are in
 * `@shared/lore` and `@shared/workspaceNames`); this is the half that did not,
 * and in the meantime the panel used a native `title` tooltip — an OS
 * rectangle in the OS font, half a second late, painted outside the glass.
 *
 * Three decisions worth keeping:
 *
 * - **A portal to `document.body`.** The panel's lists clip their overflow, and
 *   a card that is cut off at the row below it is worse than no card.
 * - **Hover AND focus.** The agent rows are buttons: someone tabbing through
 *   the panel gets the same information as someone with a mouse.
 * - **`aria-describedby`, not a `title`.** The card IS the description, so a
 *   screen reader must read it — and nothing may re-add a native tooltip on top
 *   of it, which is exactly the doubled-tooltip the old repo ended up with.
 */
export function LoreTip({ name, blurb, className }: Props): React.JSX.Element {
  const triggerRef = useRef<HTMLSpanElement>(null)
  const cardRef = useRef<HTMLDivElement>(null)
  const openTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const [open, setOpen] = useState(false)
  const [placement, setPlacement] = useState<LoreTipPlacement | null>(null)

  const measure = useCallback(() => {
    const trigger = triggerRef.current
    if (!trigger) return
    setPlacement(
      loreTipPlacement(
        trigger.getBoundingClientRect(),
        { width: window.innerWidth, height: window.innerHeight },
        cardRef.current?.getBoundingClientRect().height
      )
    )
  }, [])

  const close = useCallback(() => {
    if (openTimer.current) clearTimeout(openTimer.current)
    openTimer.current = undefined
    setOpen(false)
  }, [])

  const scheduleOpen = useCallback(() => {
    if (!blurb || openTimer.current) return
    openTimer.current = setTimeout(() => {
      openTimer.current = undefined
      measure()
      setOpen(true)
    }, LORE_TIP_OPEN_DELAY_MS)
  }, [blurb, measure])

  // The first frame is placed from an estimated height; this corrects it once
  // the real card exists — before the browser paints, so it never visibly jumps.
  useLayoutEffect(() => {
    if (open) measure()
  }, [open, measure])

  useEffect(() => () => close(), [close])

  // A card is anchored to a row that scrolls. Rather than tracking the row,
  // the card leaves: an anchor that moved is an anchor the user is no longer
  // pointing at.
  useEffect(() => {
    if (!open) return
    const dismiss = (): void => close()
    window.addEventListener('scroll', dismiss, true)
    window.addEventListener('resize', dismiss)
    return () => {
      window.removeEventListener('scroll', dismiss, true)
      window.removeEventListener('resize', dismiss)
    }
  }, [open, close])

  const tipId = `lore-${name.replace(/\s+/g, '-').toLowerCase()}`
  return (
    <>
      <span
        ref={triggerRef}
        className={className}
        aria-describedby={open ? tipId : undefined}
        onPointerEnter={scheduleOpen}
        onPointerLeave={close}
        onFocus={scheduleOpen}
        onBlur={close}
      >
        {name}
      </span>
      {open && blurb
        ? createPortal(
            <div
              ref={cardRef}
              id={tipId}
              role="tooltip"
              className={placement?.above ? 'lore-tip is-above' : 'lore-tip'}
              style={{
                left: placement?.left ?? 0,
                top: placement?.top ?? 0,
                width: placement?.width
              }}
            >
              <span className="lore-tip-name">{name}</span>
              <span className="lore-tip-text">{blurb}</span>
            </div>,
            document.body
          )
        : null}
    </>
  )
}
