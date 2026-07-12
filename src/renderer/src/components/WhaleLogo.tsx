/**
 * Orca-Strator brand mark — "Wal & Woge" in the Cozy Organic palette.
 * Colors inherit from the active light/dark token set.
 */
interface Props {
  size?: number
  /** Draw the dark rounded-square badge behind the mark (title bar / icon). */
  badge?: boolean
}

let uid = 0

export default function WhaleLogo({ size = 28, badge = true }: Props): JSX.Element {
  const id = `wal${uid++}`
  return (
    <svg width={size} height={size} viewBox="0 0 120 120" aria-hidden="true">
      <defs>
        <linearGradient id={`${id}-whale`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="var(--accent)" />
          <stop offset="1" stopColor="var(--accent-hover)" />
        </linearGradient>
        <linearGradient id={`${id}-badge`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="var(--accent-soft)" />
          <stop offset="1" stopColor="var(--accent-soft)" />
        </linearGradient>
      </defs>
      {badge && (
        <rect
          x="6"
          y="6"
          width="108"
          height="108"
          rx="27"
          fill={`url(#${id}-badge)`}
          stroke="var(--accent-line)"
          strokeWidth="2"
        />
      )}
      <path
        d="M26 58 C23 40 42 31 61 34 C77 36 86 45 91 54 C95 49 101 46 106 43
           C104 53 100 59 93 61 C89 72 73 78 56 77 C37 76 29 70 26 58 Z"
        fill={`url(#${id}-whale)`}
      />
      <circle cx="45" cy="52" r="3" fill="var(--bg)" />
      <g fill="none" stroke="var(--sage)" strokeWidth="4.8" strokeLinecap="round">
        <path d="M20 84 q13 -11 26 0 q13 11 26 0 q13 -11 26 0" />
        <path d="M26 96 q13 -9 26 0 q13 9 26 0" opacity="0.5" />
      </g>
    </svg>
  )
}
