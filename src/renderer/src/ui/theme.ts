/**
 * UI theme constants from the design handoff: provider chip colors/monograms
 * and status color semantics.
 */
import type { AgentStatus } from '@shared/agents'
import type { ProviderId } from '@shared/providers'

export interface ProviderTheme {
  label: string
  mono: string
  fg: string
  bg: string
}

export const PROVIDER_THEME: Record<ProviderId, ProviderTheme> = {
  claude: { label: 'Claude', mono: 'CL', fg: 'var(--prov-claude)', bg: 'color-mix(in srgb, var(--prov-claude) 17%, transparent)' },
  kimi: { label: 'Kimi K3', mono: 'Ki', fg: 'var(--prov-kimi)', bg: 'color-mix(in srgb, var(--prov-kimi) 17%, transparent)' },
  codex: { label: 'Codex', mono: 'Cx', fg: 'var(--prov-codex)', bg: 'color-mix(in srgb, var(--prov-codex) 17%, transparent)' },
  cursor: { label: 'Cursor', mono: 'Cu', fg: 'var(--prov-cursor)', bg: 'color-mix(in srgb, var(--prov-cursor) 17%, transparent)' },
  copilot: { label: 'GitHub Copilot', mono: 'Co', fg: 'var(--prov-github)', bg: 'color-mix(in srgb, var(--prov-github) 17%, transparent)' },
  ollama: { label: 'Ollama', mono: 'Ol', fg: 'var(--prov-ollama)', bg: 'color-mix(in srgb, var(--prov-ollama) 17%, transparent)' },
  github: { label: 'GitHub', mono: 'GH', fg: 'var(--prov-github)', bg: 'color-mix(in srgb, var(--prov-github) 17%, transparent)' },
  cloudflare: { label: 'Cloudflare', mono: 'CF', fg: 'var(--prov-cloudflare)', bg: 'color-mix(in srgb, var(--prov-cloudflare) 17%, transparent)' }
}

export interface StatusTheme {
  dot: string
  text: string
  /** i18n key of the human-readable status label — render via `t(theme.label)`. */
  label: string
}

export const STATUS_THEME: Record<AgentStatus, StatusTheme> = {
  running: { dot: 'var(--run)', text: 'var(--run-text)', label: 'ui.status.running' },
  waiting: { dot: 'var(--wait)', text: 'var(--wait-text)', label: 'ui.status.waiting' },
  error: { dot: 'var(--err)', text: 'var(--err-text)', label: 'ui.status.error' },
  stopped: { dot: 'var(--stop)', text: 'var(--stop-text)', label: 'ui.status.stopped' }
}

/**
 * xterm.js theme mirroring the DARK design tokens in cozy-organic.css — the
 * terminal stays dark even in the light theme (its background is the
 * theme-invariant `--terminal` token), so no update on theme switch is
 * needed. Palette-Regel aus docs/BRAND.md: Bronze für Akzente, Verdigris für
 * Lauf-Zustände; die ANSI-Slots blau/magenta bleiben bewusst in der warmen
 * Farbwelt.
 *
 * xterm cannot resolve CSS variables inside its theme object, therefore the
 * values exist as literals. Source of truth is the dark token block in
 * cozy-organic.css: `resolveXtermTheme()` reads the tokens listed in
 * XTERM_TOKEN_SOURCES at runtime via getComputedStyle, the literals below
 * are only the fallback for DOM-less environments (vitest runs in plain
 * node). Keep them in sync with cozy-organic.css when the palette changes.
 */
export const XTERM_THEME = {
  background: '#14171c', // --terminal (dark --bg)
  foreground: '#eae6db', // dark --text
  cursor: '#cba35a', // dark --accent
  cursorAccent: '#14171c', // --terminal
  selectionBackground: 'rgba(203,163,90,0.28)', // dark --accent @ 28% — xterm-only, kein Token
  black: '#0d1015', // dark --inset
  red: '#d9735c', // dark --err
  green: '#3e9d82', // dark --run
  yellow: '#e29b4b', // dark --wait
  blue: '#cba35a', // dark --accent
  magenta: '#f0a068', // warme Palette, kein Token (entspricht dark --prov-claude)
  cyan: '#7fb8a6', // dark --sage-strong
  white: '#eae6db', // dark --text
  brightBlack: '#7c7a70', // dark --text-3
  brightRed: '#f0a08c', // dark --err-text
  brightGreen: '#8fd0ba', // dark --run-text
  brightYellow: '#f0c08a', // dark --wait-text
  brightBlue: '#e4c888', // dark --accent-hover
  brightMagenta: '#f0dcaf', // dark --accent-strong
  brightCyan: '#a9d6c9', // xterm-only Aufhellung von Verdigris, kein Token
  brightWhite: '#f5f1e6' // xterm-only, kein Token
}

/**
 * xterm slot → dark cozy-organic token that owns the value. Slots not listed
 * here (selectionBackground, magenta, brightCyan, brightWhite) are
 * xterm-only accents without a CSS token; they always use the literal above.
 */
const XTERM_TOKEN_SOURCES: Partial<Record<keyof typeof XTERM_THEME, string>> = {
  background: '--terminal',
  foreground: '--text',
  cursor: '--accent',
  cursorAccent: '--terminal',
  black: '--inset',
  red: '--err',
  green: '--run',
  yellow: '--wait',
  blue: '--accent',
  cyan: '--sage-strong',
  white: '--text',
  brightBlack: '--text-3',
  brightRed: '--err-text',
  brightGreen: '--run-text',
  brightYellow: '--wait-text',
  brightBlue: '--accent-hover',
  brightMagenta: '--accent-strong'
}

let resolvedXtermTheme: typeof XTERM_THEME | null = null

/**
 * Resolves the terminal palette from the live stylesheet so cozy-organic.css
 * stays the single source of truth. Reads the DARK token set via a hidden
 * `.app-root[data-theme='dark']` probe — independent of the active theme,
 * because the terminal is always dark. Falls back to the XTERM_THEME
 * literals per slot when a token does not resolve (no DOM, stylesheet not
 * loaded yet); a complete read is cached for subsequent terminals.
 */
export function resolveXtermTheme(): typeof XTERM_THEME {
  if (resolvedXtermTheme) return resolvedXtermTheme
  if (typeof document === 'undefined' || typeof getComputedStyle !== 'function' || !document.body) {
    return XTERM_THEME
  }
  const probe = document.createElement('div')
  probe.className = 'app-root'
  probe.dataset.theme = 'dark'
  probe.style.display = 'none'
  document.body.appendChild(probe)
  try {
    const style = getComputedStyle(probe)
    const theme = { ...XTERM_THEME }
    let complete = true
    for (const [slot, token] of Object.entries(XTERM_TOKEN_SOURCES) as Array<
      [keyof typeof XTERM_THEME, string]
    >) {
      const value = style.getPropertyValue(token).trim()
      if (value) theme[slot] = value
      else complete = false
    }
    if (complete) resolvedXtermTheme = theme
    return theme
  } finally {
    probe.remove()
  }
}
