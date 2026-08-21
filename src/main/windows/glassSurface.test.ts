/**
 * The transparency fallback. `transparent` is fixed when a BrowserWindow is
 * constructed, so a wrong answer here is not recoverable at runtime — on a
 * Linux session without a compositor the panel paints black and the user has
 * no control left to change it. Every branch is pinned.
 */
import { describe, expect, it } from 'vitest'
import { glassSurface, OPAQUE_BACKGROUND, useTransparentWindow } from './glassSurface'
import type { GlassEnvironment } from './glassSurface'

function env(overrides: Partial<GlassEnvironment> = {}): GlassEnvironment {
  return { platform: 'linux', translucent: true, ...overrides }
}

describe('useTransparentWindow', () => {
  /** DWM and Quartz always composite — there is nothing to detect. */
  it.each(['win32', 'darwin'] as const)('stays transparent on %s', (platform) => {
    expect(useTransparentWindow(env({ platform, currentDesktop: undefined }))).toBe(true)
  })

  /**
   * The user's own switch is the explicit opt-out this module leans on when
   * the Linux heuristic below guesses wrong, so it must win everywhere.
   */
  it.each(['win32', 'darwin', 'linux'] as const)(
    'honours translucent:false on %s — that switch is the escape hatch',
    (platform) => {
      expect(
        useTransparentWindow(env({ platform, translucent: false, currentDesktop: 'GNOME' }))
      ).toBe(false)
    }
  )

  /** On Wayland the display server IS the compositor; no desktop check needed. */
  it('trusts a Wayland session even from a bare WM', () => {
    expect(useTransparentWindow(env({ sessionType: 'wayland', currentDesktop: 'sway' }))).toBe(true)
    expect(useTransparentWindow(env({ waylandDisplay: 'wayland-0', currentDesktop: 'river' }))).toBe(
      true
    )
    expect(useTransparentWindow(env({ sessionType: 'Wayland' }))).toBe(true)
  })

  it('ignores an empty WAYLAND_DISPLAY — an exported blank is not a session', () => {
    expect(useTransparentWindow(env({ sessionType: 'x11', waylandDisplay: '  ' }))).toBe(false)
  })

  /** XDG_CURRENT_DESKTOP is colon-separated and inconsistently cased. */
  it.each(['GNOME', 'ubuntu:GNOME', 'X-Cinnamon', 'KDE', 'pop:GNOME', 'Budgie:GNOME'])(
    'keeps the glass on X11 under %s',
    (currentDesktop) => {
      expect(useTransparentWindow(env({ sessionType: 'x11', currentDesktop }))).toBe(true)
    }
  )

  /**
   * A bare window manager on X11 is the actual bug: no compositing manager, so
   * a transparent window paints black. Unknown and unset read the same way —
   * losing the glass is recoverable, losing the UI is not.
   */
  it.each(['i3', 'openbox', 'awesome', 'XFCE', '', undefined])(
    'falls back to opaque on X11 under %j',
    (currentDesktop) => {
      expect(useTransparentWindow(env({ sessionType: 'x11', currentDesktop }))).toBe(false)
    }
  )

  it('falls back to opaque when the session says nothing at all', () => {
    expect(useTransparentWindow(env())).toBe(false)
  })

  /**
   * The desktop heuristic is wrong in both directions on real machines — picom
   * under i3 composites and announces nothing, a listed desktop can run with
   * compositing off. The override is the way out of either, so it outranks
   * even the user's own translucency switch.
   */
  it.each(['1', 'true', 'ON', ' on '])('forces the glass back on with %j', (forced) => {
    expect(
      useTransparentWindow(env({ sessionType: 'x11', currentDesktop: 'i3', forced }))
    ).toBe(true)
  })

  it.each(['0', 'false', 'OFF'])('forces the glass off with %j', (forced) => {
    expect(
      useTransparentWindow(env({ platform: 'darwin', currentDesktop: 'GNOME', forced }))
    ).toBe(false)
  })

  it('ignores an override that says nothing usable', () => {
    expect(useTransparentWindow(env({ platform: 'darwin', forced: 'maybe' }))).toBe(true)
    expect(useTransparentWindow(env({ platform: 'darwin', forced: '' }))).toBe(true)
    expect(
      useTransparentWindow(env({ sessionType: 'x11', currentDesktop: 'i3', forced: 'yes' }))
    ).toBe(false)
  })
})

describe('glassSurface', () => {
  /**
   * The two flags are one decision: `#00000000` behind an opaque window is
   * black on exactly the setups the fallback exists for.
   */
  it('pairs a transparent window with the alpha background', () => {
    expect(glassSurface(env({ platform: 'darwin' }), 'dark')).toEqual({
      transparent: true,
      backgroundColor: '#00000000'
    })
  })

  it.each(['dark', 'light'] as const)('paints the %s page background when opaque', (theme) => {
    expect(glassSurface(env({ sessionType: 'x11', currentDesktop: 'i3' }), theme)).toEqual({
      transparent: false,
      backgroundColor: OPAQUE_BACKGROUND[theme]
    })
  })

  /** The fallback must be a real colour, not a value that renders as glass. */
  it.each(['dark', 'light'] as const)('never falls back to an alpha colour (%s)', (theme) => {
    expect(OPAQUE_BACKGROUND[theme]).toMatch(/^#[0-9a-f]{6}$/)
  })
})
