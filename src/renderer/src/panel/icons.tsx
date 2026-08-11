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
