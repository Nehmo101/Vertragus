/**
 * Vertragus brand mark — the sprinting sighthound ("Fusione") in the active
 * token palette. Geometry from assets/fusioneMark.ts (sync with build/icon.svg).
 *
 * Drei Auslegungen desselben Zeichens:
 *   badge   — Kachel mit Rahmen (Titelleiste, App-Icon), Urfassungs-Maßstab
 *   compact — ≤ 48 px: breiteres Fenster, kein Rahmen, eine kräftige Tempospur
 *   hero    — ohne Rahmen, randfüllend im Quadrat
 * Die Kompakt-Auslegung existiert, weil das Zeichen 4,2 : 1 breit ist: im
 * Quadrat bliebe bei 30 px nur ein bronzener Strich übrig.
 */
import {
  FUSIONE_COMPACT,
  FUSIONE_EYE,
  FUSIONE_HERO_OFFSET,
  FUSIONE_MARK_OFFSET,
  FUSIONE_MARK_SCALE,
  FUSIONE_SILHOUETTE,
  FUSIONE_SLITS,
  FUSIONE_SPEED_LINES
} from '@renderer/assets/fusioneMark'

interface Props {
  size?: number
  /** Draw the rounded-square badge behind the mark (title bar / icon). */
  badge?: boolean
  /** Empty-hero scale — no badge, mark fills the square. */
  hero?: boolean
}

let uid = 0

export default function HoundLogo({ size = 28, badge = true, hero = false }: Props): JSX.Element {
  const id = `hound${uid++}`
  const compact = !hero && size <= FUSIONE_COMPACT.maxSize
  const showBadge = badge && !hero && !compact

  const placement = compact
    ? { offset: FUSIONE_COMPACT.offset, scale: FUSIONE_MARK_SCALE.compact }
    : hero
      ? { offset: FUSIONE_HERO_OFFSET, scale: FUSIONE_MARK_SCALE.hero }
      : { offset: FUSIONE_MARK_OFFSET, scale: FUSIONE_MARK_SCALE.default }

  const viewBox = compact ? FUSIONE_COMPACT.viewBox : '0 0 120 120'
  const width = compact ? Math.round(size * FUSIONE_COMPACT.aspect) : size
  const lines = compact ? FUSIONE_COMPACT.lines : FUSIONE_SPEED_LINES
  const markClass = hero
    ? 'hound-logo-mark hound-logo-mark--hero'
    : compact
      ? 'hound-logo-mark hound-logo-mark--compact'
      : 'hound-logo-mark'

  return (
    <svg
      width={width}
      height={size}
      viewBox={viewBox}
      aria-hidden="true"
      className={markClass}
      shapeRendering="geometricPrecision"
    >
      <defs>
        {/* Luminanz-Maske: hell = sichtbar, schwarz = Schlitz. Bewusst
            literale #fff/#000 — das sind keine Theme-Farben. */}
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
      <g transform={`translate(${placement.offset.x} ${placement.offset.y}) scale(${placement.scale})`}>
        <g className="hound-lines" stroke="var(--sage)" strokeLinecap="round" fill="none">
          {lines.map((line) => (
            <line
              key={`${line.y1}-${line.x2}`}
              x1={line.x1}
              y1={line.y1}
              x2={line.x2}
              y2={line.y2}
              strokeWidth={line.w}
            />
          ))}
        </g>
        <path
          d={FUSIONE_SILHOUETTE}
          fill="var(--accent)"
          // Kompakt: gleichfarbige Kontur, sonst fallen Läufe und Rute unter
          // die Pixelgröße und der Hund franst zu einem Schatten aus.
          stroke={compact ? 'var(--accent)' : undefined}
          strokeWidth={compact ? FUSIONE_COMPACT.outline : undefined}
          strokeLinejoin="round"
          strokeLinecap="round"
          mask={compact ? undefined : `url(#${id}-slits)`}
        />
        <circle
          cx={FUSIONE_EYE.cx}
          cy={FUSIONE_EYE.cy}
          r={compact ? FUSIONE_EYE.compactR : FUSIONE_EYE.r}
          fill="var(--bg)"
          opacity="0.85"
        />
      </g>
    </svg>
  )
}
