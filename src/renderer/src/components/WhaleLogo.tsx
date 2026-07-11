/**
 * Orca-Strator brand mark — "Wal & Woge": a teal whale cresting over cyan
 * waves. Rendered as a rounded-square badge for the title bar / app icon.
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
          <stop offset="0" stopColor="#2dd4bf" />
          <stop offset="1" stopColor="#22a3d6" />
        </linearGradient>
        <linearGradient id={`${id}-badge`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#0e1a28" />
          <stop offset="1" stopColor="#070f19" />
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
          stroke="rgba(45,212,191,0.45)"
          strokeWidth="2"
        />
      )}
      <path
        d="M26 58 C23 40 42 31 61 34 C77 36 86 45 91 54 C95 49 101 46 106 43
           C104 53 100 59 93 61 C89 72 73 78 56 77 C37 76 29 70 26 58 Z"
        fill={`url(#${id}-whale)`}
      />
      <circle cx="45" cy="52" r="3" fill="#04141c" />
      <g fill="none" stroke="#22d3ee" strokeWidth="4.6" strokeLinecap="round" opacity="0.9">
        <path d="M20 84 q13 -11 26 0 q13 11 26 0 q13 -11 26 0" />
        <path d="M26 96 q13 -9 26 0 q13 9 26 0" opacity="0.5" />
      </g>
    </svg>
  )
}
