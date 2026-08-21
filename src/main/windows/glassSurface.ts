/**
 * Whether a window may actually be built transparent — the ONE decision
 * `base.ts` promised to keep in a single place.
 *
 * `transparent: true` is a construction-time flag with a hard requirement: the
 * display server has to composite. On Windows (DWM) and macOS (Quartz) it
 * always does. On Linux it does not: an X11 session driven by a bare window
 * manager (i3, openbox, a stripped kiosk session) has no compositing manager,
 * and a transparent window there paints black or is left unpainted entirely —
 * the glass panel becomes an unreadable rectangle with no way back, because
 * the flag cannot be changed after the window exists.
 *
 * There is NO reliable probe for this from Node or Electron. The X11 answer is
 * the owner of the `_NET_WM_CM_S0` selection, which Electron does not expose
 * (`app.isUnityRunning()` only ever recognizes Unity), and Vertragus is not
 * going to link an X11 binding for one boolean. So the decision is made from
 * what the session actually tells us, in this order:
 *
 * 1. `VERTRAGUS_TRANSPARENT=1|0` decides outright. Step 3 is a heuristic and
 *    will be wrong in both directions — a standalone compositor (picom under
 *    i3) that the session never announces, or a listed desktop running with
 *    compositing switched off — and neither case may be left without a way
 *    out. It is an environment variable rather than a setting because the
 *    window it fixes must exist before its own settings window can be opened.
 * 2. The user's own switch. `appearance.translucent === false` already means
 *    "no see-through at all" — it is the explicit opt-out, and it now reaches
 *    the window flag instead of only the CSS.
 * 3. Wayland composites by definition — the display server IS the compositor —
 *    so a Wayland session is always safe.
 * 4. An X11 session is judged by the desktop it announces. The listed
 *    environments ship a compositing WM as part of the session; anything else
 *    (bare WM, unknown, unset) is treated as "cannot know" and gets an opaque
 *    window. A guess that costs the glass is recoverable; a guess that costs
 *    the UI is not.
 *
 * Only the transparent case may use an alpha background: an opaque window with
 * `#00000000` shows through as black on the very setups this exists for, so
 * the fallback paints the theme's own page background instead.
 */

/** Mirrors `--bg` per theme in `renderer/src/styles/tokens.css`. */
export const OPAQUE_BACKGROUND = { dark: '#0e1013', light: '#f4f1ea' } as const

export type GlassTheme = keyof typeof OPAQUE_BACKGROUND

const TRANSPARENT_BACKGROUND = '#00000000'

/**
 * X11 sessions whose desktop ships a compositing window manager as part of the
 * session itself. Matched against the components of `XDG_CURRENT_DESKTOP`,
 * which is colon-separated and inconsistently cased (`ubuntu:GNOME`,
 * `X-Cinnamon`, `KDE`).
 */
const COMPOSITING_DESKTOPS = new Set([
  'gnome',
  'gnome-classic',
  'gnome-flashback',
  'ubuntu',
  'unity',
  'kde',
  'plasma',
  'cinnamon',
  'x-cinnamon',
  'deepin',
  'pantheon',
  'budgie',
  'budgie-desktop',
  'enlightenment',
  'cosmic'
])

/** The session facts this decision reads; every field is env or settings. */
export interface GlassEnvironment {
  platform: NodeJS.Platform
  /** `appearance.translucent` — the user's explicit see-through switch. */
  translucent: boolean
  /** `XDG_SESSION_TYPE` */
  sessionType?: string | undefined
  /** `WAYLAND_DISPLAY` — set by every Wayland session, even without the above. */
  waylandDisplay?: string | undefined
  /** `XDG_CURRENT_DESKTOP` */
  currentDesktop?: string | undefined
  /** `VERTRAGUS_TRANSPARENT` — the override above; anything else is ignored. */
  forced?: string | undefined
}

/** true/false from the override, or undefined when it says nothing usable. */
function forcedTransparency(forced: string | undefined): boolean | undefined {
  const value = forced?.trim().toLowerCase()
  if (value === '1' || value === 'true' || value === 'on') return true
  if (value === '0' || value === 'false' || value === 'off') return false
  return undefined
}

function isWaylandSession(env: GlassEnvironment): boolean {
  return (
    env.sessionType?.trim().toLowerCase() === 'wayland' ||
    (env.waylandDisplay ?? '').trim().length > 0
  )
}

function namesCompositingDesktop(currentDesktop: string | undefined): boolean {
  return (currentDesktop ?? '')
    .split(':')
    .map((name) => name.trim().toLowerCase())
    .some((name) => COMPOSITING_DESKTOPS.has(name))
}

/** See the module contract for why each step is where it is. */
export function useTransparentWindow(env: GlassEnvironment): boolean {
  const forced = forcedTransparency(env.forced)
  if (forced !== undefined) return forced
  if (!env.translucent) return false
  if (env.platform !== 'linux') return true
  if (isWaylandSession(env)) return true
  return namesCompositingDesktop(env.currentDesktop)
}

export interface GlassSurface {
  transparent: boolean
  backgroundColor: string
}

/** The two window flags that must always be decided together. */
export function glassSurface(env: GlassEnvironment, theme: GlassTheme): GlassSurface {
  const transparent = useTransparentWindow(env)
  return {
    transparent,
    backgroundColor: transparent ? TRANSPARENT_BACKGROUND : OPAQUE_BACKGROUND[theme]
  }
}
