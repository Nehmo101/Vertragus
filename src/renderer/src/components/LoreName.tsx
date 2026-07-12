import { useCallback, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { tolkienBlurb } from '@shared/tolkien'

interface Props {
  /** The agent code-name, e.g. "Smaug". */
  name: string
  /** Extra class(es) for the visible name span (e.g. "pane-name"). */
  className?: string
}

/** Half of the tooltip's max-width (see `.lore-tip` in styles.css). */
const TIP_HALF = 130

/**
 * Renders an agent's Tolkien code-name. Hovering (or focusing) reveals a small
 * tooltip that explains who the character is. The tooltip is portalled to
 * <body> with fixed positioning, so the pane's `overflow: hidden` ancestors
 * never clip it. Names outside the cast simply render without a tooltip.
 */
export default function LoreName({ name, className }: Props): JSX.Element {
  const blurb = tolkienBlurb(name)
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
    return <span className={className}>{name}</span>
  }

  return (
    <>
      <span
        ref={anchorRef}
        className={`lore-name ${className ?? ''}`.trim()}
        tabIndex={0}
        aria-label={`${name} — ${blurb}`}
        onMouseEnter={show}
        onMouseLeave={hide}
        onFocus={show}
        onBlur={hide}
      >
        {name}
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
