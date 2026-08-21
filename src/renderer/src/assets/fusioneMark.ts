/**
 * Fusione mark geometry — canonical paths for HoundLogo + build/icon.svg.
 *
 * Wiederhergestellte Urfassung des Zeichens (Archiv-Commit e39245e,
 * 2026-07-17, „rebrand: Vertragus phase 1 — hound logo"). Der spätere
 * „AAA"-Feinschliff (Archiv-Commit 2d87a48, 2026-08-10, Fassungen v2–v4)
 * hatte dem Windhund Läufe und Schnauze wegpoliert; übrig blieb ein
 * bronzener Klumpen. Diese Datei trägt wieder die Galopp-Kontur der
 * Urfassung: gestreckter Windhund, Kopf rechts, vier Läufe, Rute nach
 * hinten in die dritte Tempolinie auslaufend.
 *
 * Brand shorthand (see README.md's mark description and build/icon.svg):
 * galloping greyhound, speed slits through loin and croup, tail running out
 * into line 3, line 4 behind the legs, folded ear, bronze front / verdigris
 * rear.
 */

/**
 * Galopp-Kontur in lokalen Koordinaten (vor translate/scale).
 * Bounding-Box: x 20.2 … 121, y 15.95 … 39.85 — ein sehr breites Zeichen
 * (rund 4,2 : 1). Kopf und Schnauze liegen rechts, das angelegte Ohr ist die
 * Einkerbung bei x ≈ 100–105, die Rute läuft links bei x ≈ 20 aus.
 */
export const FUSIONE_SILHOUETTE =
  'M121 24.2 C117.5 23.1 114 22.1 110.5 21.2 C109.2 20.8 107.6 20.3 106.3 20.2 ' +
  'C105.6 20.1 105.2 20 104.8 20 C104 19.2 103.2 18.7 102.4 18.8 C101.6 18.9 100.9 19.4 100 19.9 ' +
  'C96.5 20.1 93 19.4 89.5 18.6 C86.5 18 84.2 17.7 82 17.6 C78.5 17.35 75.5 17.1 72.5 16.8 ' +
  'C68.5 16.35 64.5 15.95 61.5 16.05 C58.5 16.35 55.8 17 53.5 17.9 C52.2 18.4 51 18.9 50 19.4 ' +
  'C47 20.6 43.8 21.6 40.5 22.35 C36.5 23.2 31.5 23.45 26.8 23.35 C24.5 23.3 22.5 23 20.9 22.65 ' +
  'C20.3 22.55 20.2 23.2 20.75 23.4 C24.4 24.4 28.8 24.75 33 24.65 C37.5 24.55 41.5 24 44.8 23.2 ' +
  'C45.8 22.95 46.7 22.68 47.5 22.4 C45.9 23.5 44.3 24.6 43 25.5 C41.3 26.8 39.7 27.9 38.5 29 ' +
  'C36.6 30.6 34.8 32 33 33.2 C31.6 34.3 30.3 35.3 29.2 36.2 C28.5 36.8 28.5 37.35 29.3 37.25 ' +
  'C31.5 35.9 33.8 34.3 36 32.6 C38.8 30.4 41.6 28.2 44 26 C44.9 25.2 45.7 24.7 46.5 24.4 ' +
  'C44.9 26.3 43.2 28.5 41.8 30.4 C40.4 32.2 38.9 33.5 37.4 34.6 C36.2 35.9 35.1 37.2 34.2 38.6 ' +
  'C33.6 39.3 33.8 39.85 34.7 39.6 C36.4 38.2 38 36.6 39.6 34.9 C42.4 31.9 45 29.2 47.5 27.2 ' +
  'C48.7 26.3 49.9 25.4 51 24.6 C54 22.5 57 21.6 60 21.55 C63 21.5 66 22.3 68.5 23.4 ' +
  'C72 25 75.8 27.6 78.5 29.8 C79.3 30.4 80.2 30.7 81 30.6 C83.4 31.6 86 32.6 88.4 33.8 ' +
  'C90.8 34.9 93.2 35.9 95.6 36.9 C97.1 37.5 98.4 38 99.6 38.3 C100.5 38.5 100.7 37.9 100 37.5 ' +
  'C97.4 36.1 94.6 34.7 92 33.2 C90 32.05 88.2 30.9 86.6 29.7 C86.3 29.45 86.05 29.2 85.8 29 ' +
  'C88.6 30 92 31 95.5 31.9 C99.5 32.9 103.5 33.6 107.5 34.1 C109.5 34.35 111.2 34.5 112.6 34.55 ' +
  'C113.7 34.6 113.9 33.9 113.1 33.55 C109.5 32.6 105.5 31.7 101.5 30.8 C97 29.75 92.5 28.3 88.5 26.4 ' +
  'C89.5 25.6 90.8 24.9 92.5 24.3 C95.5 23.3 99 22.75 102.5 22.7 C106.5 22.65 110.5 23 114 23.4 ' +
  'C116.8 23.7 119.2 23.95 121 24.2 Z'

/**
 * Rute, angelegtes Ohr, Ohr-Innenfalte, Vorderpfote und Schnauzen-Sheen sind
 * in der Urfassung Teil der Kontur und keine eigenen Formen — genau das machte
 * das Zeichen bei kleinen Größen ruhig. Der spätere Feinschliff hatte sie als
 * lose Einzelteile herausgelöst (Ohr als Beule auf dem Rücken, Pfote als
 * schwebender Punkt). Die Namen bleiben als Schnittstelle erhalten; `null`
 * heißt „steckt in der Silhouette".
 */
export const FUSIONE_TAIL: string | null = null
export const FUSIONE_EAR: string | null = null
export const FUSIONE_EAR_INNER: string | null = null
export const FUSIONE_PAW: string | null = null
export const FUSIONE_HIGHLIGHT: string | null = null

/** Badge-Format (Titelleiste, App-Icon): Zeichen sitzt in der 108er-Kachel. */
export const FUSIONE_MARK_OFFSET = { x: 14.5, y: 37.4 }

/**
 * default = Badge-Format (Urfassung), hero/compact = randfüllend ohne Badge.
 * Bei 4,2 : 1 Seitenverhältnis entscheidet die Skalierung darüber, ob man
 * einen Hund oder einen Strich sieht.
 */
export const FUSIONE_MARK_SCALE = { default: 0.85, compact: 1.02, hero: 1.13 }

/** Hero (≥ 80 px, ohne Badge): randfüllend im Quadrat. */
export const FUSIONE_HERO_OFFSET = { x: -19.8, y: 28.75 }

/**
 * Kompaktformat (Panel-Leiste, ≤ 48 px).
 *
 * Ein 4,2 : 1 breites Zeichen in eine quadratische Kachel gezwängt ergibt bei
 * 30 px einen 6 px hohen Streifen — der „bronzene Strich", über den sich der
 * Besitzer beschwert hat. Deshalb bekommt das Kompaktformat ein eigenes,
 * breiteres Fenster (1,6 : 1), keinen Badge-Rahmen und statt der vier
 * feingliedrigen Tempolinien eine kräftige Spur: vier Linien mit 3 Einheiten
 * Abstand verschmelzen bei 30 px zu einem Block.
 */
export const FUSIONE_COMPACT = {
  /** Bis zu dieser Kantenlänge wird das Kompaktformat gezeichnet. */
  maxSize: 48,
  viewBox: '0 0 120 75',
  /** Breite = Höhe × aspect. */
  aspect: 1.6,
  offset: { x: -6.6, y: 9 },
  /** Bronze-Kontur, damit die dünnen Läufe im Subpixelbereich nicht verschwinden. */
  outline: 1.2,
  lines: [{ x1: -20, y1: 21.5, x2: 30, y2: 21.5, w: 2.4 }]
} as const

/** Verdigris-Tempolinien; y-Lagen decken sich mit den Schlitzen in der Lende. */
export const FUSIONE_SPEED_LINES = [
  { x1: -14, y1: 17.8, x2: 68, y2: 17.8, w: 1.6 },
  { x1: -10, y1: 20.65, x2: 62, y2: 20.65, w: 1.5 },
  { x1: -16, y1: 23.5, x2: 18.5, y2: 23.5, w: 1.5 },
  { x1: -6, y1: 27.2, x2: 46, y2: 27.2, w: 1.4 }
] as const

/**
 * Tempo-Schlitze: zwei Linien schneiden durch Lende und Kruppe. Kantige Enden
 * (butt), wie in der Urfassung, wo sie als Rechtecke in der Maske lagen.
 */
export const FUSIONE_SLITS = [
  { x1: -24, y1: 17.8, x2: 62, y2: 17.8, w: 1.6 },
  { x1: -24, y1: 20.65, x2: 56, y2: 20.65, w: 1.5 }
] as const

/** Auge — im Kompaktformat minimal größer, sonst fällt es unter ein Pixel. */
export const FUSIONE_EYE = { cx: 110.2, cy: 22.35, r: 0.75, compactR: 1 }
