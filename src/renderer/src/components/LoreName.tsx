import { useCallback, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { tolkienBlurb } from '@shared/tolkien'

interface Props {
  /** The code-name looked up for the tooltip and shown as its heading, e.g. "Smaug". */
  name: string
  /** Extra class(es) for the visible name span (e.g. "pane-name"). */
  className?: string
  /** Visible text, if it differs from `name` (e.g. "W1 Minas Tirith"). Defaults to `name`. */
  label?: string
  /**
   * Explicit tooltip text. When omitted the agent lore (`tolkienBlurb`) is used,
   * so callers with their own lore source (e.g. workspace places) pass it here.
   */
  blurb?: string
}

/** Half of the tooltip's max-width (see `.lore-tip` in styles.css). */
const TIP_HALF = 130

/**
 * Renders an agent's Tolkien code-name. Hovering (or focusing) reveals a small
 * tooltip that explains who the character is. The tooltip is portalled to
 * <body> with fixed positioning, so the pane's `overflow: hidden` ancestors
 * never clip it. Names outside the cast simply render without a tooltip.
 */
export default function LoreName({ name, className, label, blurb: blurbProp }: Props): JSX.Element {
  const blurb = blurbProp ?? tolkienBlurb(name)
  const text = label ?? name
  const anchorRef = useRef<HTMLSpanElement>(null)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)

  const show = useCallback(() => {
    const el = anchorRef.current
    if (!el || !blurb) return
    const r = el.getBoundingClientRect()
    // Centre on the name, but keep the whole bubble inside the viewport.
    const center = r.left + r.width / 2
    const min = TIP_HALF + 8
    const max = window.innerWidth - TIP_HALF - 8
    const left = max > min ? Math.min(Math.max(center, min), max) : center
    setPos({ left, top: r.bottom + 8 })
  }, [blurb])

  const hide = useCallback(() => setPos(null), [])

  if (!blurb) {
    return <span className={className}>{text}</span>
  }

  return (
    <>
      <span
        ref={anchorRef}
        className={`lore-name ${className ?? ''}`.trim()}
        tabIndex={0}
        aria-label={`${text} — ${blurb}`}
        onMouseEnter={show}
        onMouseLeave={hide}
        onFocus={show}
        onBlur={hide}
      >
        {text}
      </span>
      {pos &&
        createPortal(
          <div className="lore-tip" role="tooltip" style={{ left: pos.left, top: pos.top }}>
            <span className="lore-tip-name">{name}</span>
            <span className="lore-tip-text">{blurb}</span>
          </div>,
          document.body
        )}
    </>
  )
}
