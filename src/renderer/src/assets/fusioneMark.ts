/**
 * Fusione mark geometry — canonical paths for HoundLogo + build/icon.svg.
 * BRAND.md: galloping sighthound, tempo slits through loin, tail → line 3,
 * line 4 behind legs, folded ear, bronze front / verdigris tempo rear.
 */

/** Polished single-contour silhouette (local coords, pre translate/scale). v4: forward snout + neck read at 46px. */
export const FUSIONE_SILHOUETTE =
  'M126.6 22.2 C125.2 19.6 122.0 17.8 116.2 17.6 C109.2 17.4 100.4 16.8 91.4 16.4 ' +
  'C81.8 16.0 72.6 16.2 63.6 17.4 C55.0 18.6 46.8 20.2 38.6 21.4 C31.6 22.4 26.8 22.2 25.0 21.0 ' +
  'C23.8 20.2 25.6 19.4 29.2 19.8 C34.4 20.8 39.2 23.6 41.4 27.6 C42.6 30.4 41.8 33.2 43.4 34.8 ' +
  'C45.6 36.6 49.2 34.8 53.0 31.2 C58.6 26.6 65.6 23.2 73.8 21.6 C82.6 20.0 91.4 21.0 98.8 24.2 ' +
  'C105.4 27.0 110.8 29.6 114.2 31.6 C117.4 33.4 120.0 33.6 121.6 32.0 C123.6 29.8 124.8 26.2 125.6 23.4 ' +
  'C126.0 22.4 127.2 22.0 126.6 22.2 Z'

/** Tail stroke flowing into tempo line 3 (BRAND differentiator). */
export const FUSIONE_TAIL =
  'M44.8 33.6 C41.2 31.4 37.0 28.2 34.0 25.8 C31.2 23.6 29.0 23.4 28.2 24.6 C26.4 23.8 22.0 23.6 18.5 23.5'

/** Folded ear — outer shell (BRAND differentiator). v4: wider shell for 46px legibility. */
export const FUSIONE_EAR =
  'M108.2 17.4 C104.6 14.2 99.6 13.4 96.8 14.6 C94.4 15.4 93.8 17.6 95.8 19.0 C98.4 20.6 103.8 20.0 108.2 17.4 Z'

/** Ear inner fold shadow for clarity at 46–96px. */
export const FUSIONE_EAR_INNER =
  'M104.8 17.8 C103.0 16.0 100.8 15.6 99.4 16.2 C98.2 16.8 98.4 18.0 99.8 18.6 C101.4 19.2 103.4 18.6 104.8 17.8 Z'

/** Optical forepaw correction under chest tuck. */
export const FUSIONE_PAW =
  'M40.0 35.4 C38.2 33.8 37.0 35.6 38.4 36.8 C39.6 37.6 41.0 36.2 40.0 35.4 Z'

/** Snout/back highlight — subtle bronze sheen. v4: tracks extended snout. */
export const FUSIONE_HIGHLIGHT =
  'M124.2 21.8 C120.0 19.4 114.4 18.0 108.4 17.8 C102.2 17.6 96.4 16.6 90.4 16.2 C85.0 15.8 80.0 15.4 75.6 15.6'

export const FUSIONE_MARK_OFFSET = { x: 13.2, y: 36.6 }
export const FUSIONE_MARK_SCALE = { default: 0.88, compact: 0.91, hero: 0.94 }

/** Verdigris tempo lines — y positions align with hindquarter mask slits. */
export const FUSIONE_SPEED_LINES = [
  { x1: -14, y1: 17.8, x2: 68, y2: 17.8, w: 1.6 },
  { x1: -10, y1: 20.65, x2: 62, y2: 20.65, w: 1.5 },
  { x1: -16, y1: 23.5, x2: 18.5, y2: 23.5, w: 1.5 },
  { x1: -6, y1: 27.2, x2: 46, y2: 27.2, w: 1.4 }
] as const

/** Mask slits — rounded caps, matched to lines 1–2. */
export const FUSIONE_SLITS = [
  { x1: -14, y1: 17.8, x2: 68, y2: 17.8, w: 1.5 },
  { x1: -10, y1: 20.65, x2: 62, y2: 20.65, w: 1.4 }
] as const

export const FUSIONE_EYE = { cx: 113.0, cy: 21.4, r: 1.14 }
