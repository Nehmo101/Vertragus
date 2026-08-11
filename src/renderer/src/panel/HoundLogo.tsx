/**
 * Vertragus brand mark — the sprinting sighthound ("Fusione") in the active
 * token palette. Geometry from assets/fusioneMark.ts (sync with build/icon.svg).
 */
import {
  FUSIONE_EAR,
  FUSIONE_EAR_INNER,
  FUSIONE_EYE,
  FUSIONE_HIGHLIGHT,
  FUSIONE_MARK_OFFSET,
  FUSIONE_MARK_SCALE,
  FUSIONE_PAW,
  FUSIONE_SILHOUETTE,
  FUSIONE_SLITS,
  FUSIONE_SPEED_LINES,
  FUSIONE_TAIL
} from '@renderer/assets/fusioneMark'

interface Props {
  size?: number
  /** Draw the rounded-square badge behind the mark (title bar / icon). */
  badge?: boolean
  /** Empty-hero scale — no badge, stronger stroke for 80–96px. */
  hero?: boolean
}

let uid = 0

export default function HoundLogo({ size = 28, badge = true, hero = false }: Props): JSX.Element {
  const id = `hound${uid++}`
  const showBadge = hero ? false : badge
  const compact = !hero && size <= 52
  const strokeWidth = hero ? 0.58 : compact ? 0.54 : 0.44
  const markScale = hero
    ? FUSIONE_MARK_SCALE.hero
    : compact
      ? FUSIONE_MARK_SCALE.compact
      : FUSIONE_MARK_SCALE.default
  const markClass = hero
    ? 'hound-logo-mark hound-logo-mark--hero'
    : compact
      ? 'hound-logo-mark hound-logo-mark--compact'
      : 'hound-logo-mark'
  const lineBoost = hero ? 0.14 : compact ? 0.1 : 0
  const eyeBoost = hero ? 0.08 : compact ? 0.1 : 0

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 120 120"
      aria-hidden="true"
      className={markClass}
      shapeRendering="geometricPrecision"
    >
      <defs>
        <linearGradient id={`${id}-bronze`} x1="0.12" y1="0.04" x2="0.88" y2="0.96">
          <stop offset="0" stopColor="var(--accent-strong, var(--accent))" />
          <stop offset="0.48" stopColor="var(--accent)" />
          <stop offset="1" stopColor="color-mix(in srgb, var(--accent) 68%, var(--text) 32%)" />
        </linearGradient>
        <linearGradient id={`${id}-sheen`} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="color-mix(in srgb, var(--accent) 0%, transparent)" />
          <stop offset="0.45" stopColor="color-mix(in srgb, var(--accent) 35%, transparent)" />
          <stop offset="1" stopColor="color-mix(in srgb, var(--accent) 0%, transparent)" />
        </linearGradient>
        <mask id={`${id}-slits`} maskUnits="userSpaceOnUse" x="-24" y="0" width="160" height="64">
          <rect x="-24" y="0" width="160" height="64" fill="#fff" />
          {FUSIONE_SLITS.map((slit) => (
            <line
              key={`${slit.y1}-${slit.x2}`}
              x1={slit.x1}
              y1={slit.y1}
              x2={slit.x2}
              y2={slit.y2}
              stroke="#000"
              strokeWidth={slit.w}
              strokeLinecap="round"
            />
          ))}
        </mask>
      </defs>
      {showBadge && (
        <rect
          x="6"
          y="6"
          width="108"
          height="108"
          rx="27"
          fill="var(--accent-soft)"
          stroke="var(--accent-line)"
          strokeWidth="2"
        />
      )}
      <g transform={`translate(${FUSIONE_MARK_OFFSET.x} ${FUSIONE_MARK_OFFSET.y}) scale(${markScale})`}>
        <g className="hound-lines" stroke="var(--sage)" strokeLinecap="round" fill="none">
          {FUSIONE_SPEED_LINES.map((line) => (
            <line
              key={`${line.y1}-${line.x2}`}
              x1={line.x1}
              y1={line.y1}
              x2={line.x2}
              y2={line.y2}
              strokeWidth={line.w + lineBoost}
            />
          ))}
        </g>
        <path
          d={FUSIONE_TAIL}
          fill="none"
          stroke="var(--sage)"
          strokeWidth={(hero ? 1.35 : 1.2) + lineBoost}
          strokeLinecap="round"
          opacity="0.88"
        />
        <path
          d={FUSIONE_SILHOUETTE}
          fill={`url(#${id}-bronze)`}
          stroke="var(--accent-line)"
          strokeWidth={strokeWidth}
          strokeLinejoin="round"
          strokeLinecap="round"
          paintOrder="stroke fill"
          mask={`url(#${id}-slits)`}
        />
        <path
          d={FUSIONE_HIGHLIGHT}
          fill="none"
          stroke={`url(#${id}-sheen)`}
          strokeWidth={hero ? 1.1 : 0.9}
          strokeLinecap="round"
          opacity="0.55"
        />
        <path d={FUSIONE_PAW} fill="color-mix(in srgb, var(--accent) 78%, var(--text) 22%)" opacity="0.85" />
        <path d={FUSIONE_EAR} fill="color-mix(in srgb, var(--accent) 92%, var(--text) 8%)" />
        <path d={FUSIONE_EAR_INNER} fill="color-mix(in srgb, var(--accent) 55%, var(--text) 45%)" opacity="0.7" />
        <circle
          cx={FUSIONE_EYE.cx}
          cy={FUSIONE_EYE.cy}
          r={FUSIONE_EYE.r + eyeBoost}
          fill="var(--bg)"
          stroke="var(--accent-line)"
          strokeWidth={compact ? 0.32 : 0.28}
        />
      </g>
    </svg>
  )
}
