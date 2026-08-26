/**
 * The panel's glyph set — inline SVG, no icon dependency.
 *
 * All of them are stroke-based on a 24×24 grid except the two filled shapes
 * (play, stop) that the mockup draws as solid marks. `currentColor` everywhere,
 * so a button's hover state colours its icon without a second rule.
 */

interface IconProps {
  size?: number
}

export function PlayIcon({ size = 9 }: IconProps): React.JSX.Element {
  return (
    <svg width={size} height={size + 1} viewBox="0 0 9 10" aria-hidden="true" focusable="false">
      <path d="M0.6 0.6 8 5 0.6 9.4Z" fill="currentColor" />
    </svg>
  )
}

export function StopIcon({ size = 8 }: IconProps): React.JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 8 8" aria-hidden="true" focusable="false">
      <rect x="0" y="0" width="8" height="8" rx="1.6" fill="currentColor" />
    </svg>
  )
}

/**
 * A gear, not a sun: at 13px the teeth have to touch the ring, otherwise the
 * glyph reads as a brightness control. Ring at r=5.2, eight teeth from r=5.4
 * out to r=8.6, hub in the middle.
 */
export function GearIcon({ size = 13 }: IconProps): React.JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      aria-hidden="true"
      focusable="false"
    >
      <path
        strokeWidth="2.6"
        d="M12 3.4v3.2M12 17.4v3.2M20.6 12h-3.2M6.6 12H3.4M18.1 5.9 15.8 8.2M8.2 15.8 5.9 18.1M18.1 18.1 15.8 15.8M8.2 8.2 5.9 5.9"
      />
      <circle cx="12" cy="12" r="5.2" strokeWidth="2" />
      <circle cx="12" cy="12" r="1.9" strokeWidth="1.6" />
    </svg>
  )
}

/** The profile row's "archived runs" mark — a clock, because Stop already used the square. */
export function ClockIcon({ size = 13 }: IconProps): React.JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="12" cy="12" r="8.2" />
      <path d="M12 7.5v4.7l3.2 1.8" />
    </svg>
  )
}

/** The panel footer's voice assistant mark. */
export function MicIcon({ size = 14 }: IconProps): React.JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <rect x="9" y="3.5" width="6" height="11" rx="3" />
      <path d="M6.5 11.5a5.5 5.5 0 0 0 11 0" />
      <path d="M12 17v3.2M9 20.5h6" />
    </svg>
  )
}

export function EyeIcon({ size = 14 }: IconProps): React.JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M2.2 12S6 5.6 12 5.6 21.8 12 21.8 12 18 18.4 12 18.4 2.2 12 2.2 12Z" />
      <circle cx="12" cy="12" r="2.9" />
    </svg>
  )
}

/** The panel head's "hide everything" mark — the same action as the eye. */
export function MinusIcon({ size = 13 }: IconProps): React.JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M5 12h14" />
    </svg>
  )
}

/** The panel head's "quit Vertragus" mark. */
export function CloseIcon({ size = 13 }: IconProps): React.JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M6 6 18 18M18 6 6 18" />
    </svg>
  )
}

/** The profile row's "clean up old worktrees" mark. */
export function BroomIcon({ size = 13 }: IconProps): React.JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M19.6 3.4 12.4 10.6" />
      <path d="M12.4 10.6c-2.5-.7-4.7 0-6.3 2.4l7.9 4.7c1.6-2.3 2-4.6 1.1-7.1Z" />
      <path d="M8.6 15.9 7 18.6M11.8 17.8l-1 2.5" />
    </svg>
  )
}

/** The profile row's "what the app learned" mark — a small ascending chart. */
export function ChartIcon({ size = 13 }: IconProps): React.JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M4 4v15.2a.8.8 0 0 0 .8.8H20" />
      <path d="M8 15.5v1.8M12.5 12v5.3M17 8.5v8.8" />
    </svg>
  )
}

/** One cleanup entry's "remove this worktree" mark. */
export function TrashIcon({ size = 12 }: IconProps): React.JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M4.5 6.5h15M9.5 6.5V4.9a1.4 1.4 0 0 1 1.4-1.4h2.2a1.4 1.4 0 0 1 1.4 1.4v1.6" />
      <path d="M7 6.5l.8 12.1a1.7 1.7 0 0 0 1.7 1.6h5a1.7 1.7 0 0 0 1.7-1.6L17 6.5" />
      <path d="M10.3 10.2v5.8M13.7 10.2v5.8" />
    </svg>
  )
}

export function FolderIcon({ size = 13 }: IconProps): React.JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M3 6.6A1.6 1.6 0 0 1 4.6 5h4.1l1.9 2.2h8.8A1.6 1.6 0 0 1 21 8.8v8.6A1.6 1.6 0 0 1 19.4 19H4.6A1.6 1.6 0 0 1 3 17.4Z" />
    </svg>
  )
}

/** Section-header chevron — points down when expanded, right when collapsed. */
export function ChevronIcon({
  size = 11,
  expanded = false
}: IconProps & { expanded?: boolean }): React.JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      style={{ transform: expanded ? 'rotate(90deg)' : undefined, transition: 'transform 0.18s ease' }}
    >
      <path d="M9 6 15 12 9 18" />
    </svg>
  )
}
