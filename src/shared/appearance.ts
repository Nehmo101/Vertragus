/**
 * How see-through Vertragus is — the one trait every window shares.
 *
 * Until now the glass was a constant: 0.6 at rest, 0.97 on hover, 1 while
 * typing, with the alpha of every surface baked into `tokens.css`. That is a
 * good default and a bad rule — a dark wallpaper wants more transparency, a
 * photo wallpaper wants less, and a user who simply does not want a see-through
 * app had no way to say so.
 *
 * So the values move here, and this module is the single authority on them:
 *
 * - **Two different things.** `restOpacity`/`hoverOpacity`/`focusOpacity` are
 *   the WINDOW's opacity (how much of the desktop shines through the whole
 *   sheet, GPU-composited). `surfaceTransparency` scales the alpha the glass
 *   surfaces were designed with — the background, not the element. Turning one
 *   down is not the same as turning the other down, and the settings window
 *   says so in two separate controls.
 * - **One master switch.** `translucent: false` means opaque, full stop: every
 *   opacity is 1 and the designed alpha collapses to solid. The sliders keep
 *   their stored values so switching back restores the user's glass.
 *
 * Deliberately dependency-free (no zod, no DOM): the main store validates
 * through it, the renderer turns it into CSS variables, and both halves are
 * unit-testable in plain Node.
 */

export interface Appearance {
  /** The master switch: false = fully opaque windows, no see-through at all. */
  translucent: boolean
  /** Window opacity while nothing points at it — the ghost state. */
  restOpacity: number
  /** Window opacity while the pointer is over it. */
  hoverOpacity: number
  /** Window opacity while the OS focus is in it (CLI windows type here). */
  focusOpacity: number
  /**
   * How much of the DESIGNED surface transparency to keep, 0–1. `1` is the
   * mockup's glass, `0` paints every surface solid. Scaling the design instead
   * of setting an absolute alpha is what keeps the panel, the title bar and
   * the terminal in the same relation to each other at every setting.
   */
  surfaceTransparency: number
}

/** The mockup's values — what every install starts with. */
export const DEFAULT_APPEARANCE: Appearance = {
  translucent: true,
  restOpacity: 0.6,
  hoverOpacity: 0.97,
  focusOpacity: 1,
  surfaceTransparency: 1
}

/**
 * Per-field bounds. The lower limits are not cosmetic: a window at 0.05 is
 * invisible AND still on top, which is indistinguishable from a hung app —
 * and the hovered state has to stay readable enough to find the way back.
 */
export const APPEARANCE_LIMITS = {
  restOpacity: { min: 0.2, max: 1 },
  hoverOpacity: { min: 0.4, max: 1 },
  focusOpacity: { min: 0.4, max: 1 },
  surfaceTransparency: { min: 0, max: 1 }
} as const

export type AppearanceSlider = keyof typeof APPEARANCE_LIMITS

/** The sliders in the order the settings window shows them. */
export const APPEARANCE_SLIDERS: readonly AppearanceSlider[] = [
  'restOpacity',
  'hoverOpacity',
  'focusOpacity',
  'surfaceTransparency'
]

function clamp(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, value))
}

/**
 * Read anything, answer with a usable appearance.
 *
 * Fail-soft like the rest of the store: a hand-edited config, a value from a
 * future version or plain junk costs the offending FIELD its value, never the
 * whole object and never the app's ability to paint.
 *
 * The one rule beyond clamping is the ladder: resting ≤ hover ≤ focus. A hover
 * state fainter than the resting one reads as "the window disappears when I
 * reach for it", so an inverted pair is lifted rather than rejected.
 */
export function normalizeAppearance(raw: unknown): Appearance {
  const input = (raw && typeof raw === 'object' ? raw : {}) as Partial<Record<keyof Appearance, unknown>>
  const restOpacity = clamp(
    input.restOpacity,
    DEFAULT_APPEARANCE.restOpacity,
    APPEARANCE_LIMITS.restOpacity.min,
    APPEARANCE_LIMITS.restOpacity.max
  )
  const hoverOpacity = Math.max(
    restOpacity,
    clamp(
      input.hoverOpacity,
      DEFAULT_APPEARANCE.hoverOpacity,
      APPEARANCE_LIMITS.hoverOpacity.min,
      APPEARANCE_LIMITS.hoverOpacity.max
    )
  )
  return {
    translucent: typeof input.translucent === 'boolean' ? input.translucent : DEFAULT_APPEARANCE.translucent,
    restOpacity,
    hoverOpacity,
    focusOpacity: Math.max(
      hoverOpacity,
      clamp(
        input.focusOpacity,
        DEFAULT_APPEARANCE.focusOpacity,
        APPEARANCE_LIMITS.focusOpacity.min,
        APPEARANCE_LIMITS.focusOpacity.max
      )
    ),
    surfaceTransparency: clamp(
      input.surfaceTransparency,
      DEFAULT_APPEARANCE.surfaceTransparency,
      APPEARANCE_LIMITS.surfaceTransparency.min,
      APPEARANCE_LIMITS.surfaceTransparency.max
    )
  }
}

/** The CSS custom properties `tokens.css` is written against. */
export interface AppearanceVars {
  '--ghost-opacity': string
  '--reveal-opacity': string
  '--focus-opacity': string
  /** 0–1 factor on every surface's designed alpha; 0 paints them solid. */
  '--glass-see-through': string
}

/**
 * Turn an appearance into the four variables every window sets on `:root`.
 *
 * `translucent: false` is resolved HERE and not in CSS, so there is exactly one
 * place that knows what "opaque" means — and the stored slider values survive
 * the switch untouched.
 */
export function appearanceCssVars(appearance: Appearance): AppearanceVars {
  const value = normalizeAppearance(appearance)
  if (!value.translucent) {
    return {
      '--ghost-opacity': '1',
      '--reveal-opacity': '1',
      '--focus-opacity': '1',
      '--glass-see-through': '0'
    }
  }
  return {
    '--ghost-opacity': String(value.restOpacity),
    '--reveal-opacity': String(value.hoverOpacity),
    '--focus-opacity': String(value.focusOpacity),
    '--glass-see-through': String(value.surfaceTransparency)
  }
}

/** Root class for the opaque mode — see `tokens.css` (drops the blur). */
export const OPAQUE_ROOT_CLASS = 'is-opaque'
