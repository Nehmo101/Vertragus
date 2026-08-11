import type { ITheme } from '@xterm/xterm'

/**
 * The terminal palette from the approved glass mockup. Always dark — an agent
 * terminal never follows a light theme — and always transparent: the visible
 * background comes from the CSS token `--glass-terminal` behind the canvas, so
 * the same values work for the WebGL and the DOM renderer.
 */
export const TERMINAL_FOREGROUND = '#e7e3d7'
export const TERMINAL_ACCENT_BRONZE = '#d9b36a'
export const TERMINAL_ACCENT_VERDIGRIS = '#6fae9b'
export const TERMINAL_ACCENT_RED = '#d9735c'
export const TERMINAL_DIM = '#8b8a7e'

export const XTERM_THEME: ITheme = {
  background: 'rgba(0, 0, 0, 0)',
  foreground: TERMINAL_FOREGROUND,
  cursor: TERMINAL_ACCENT_BRONZE,
  cursorAccent: '#0d1015',
  selectionBackground: 'rgba(203, 163, 90, 0.28)',
  selectionForeground: undefined,

  black: '#14171c',
  red: TERMINAL_ACCENT_RED,
  green: TERMINAL_ACCENT_VERDIGRIS,
  yellow: TERMINAL_ACCENT_BRONZE,
  blue: '#8fa8c8',
  magenta: '#b98fc0',
  cyan: '#7fbfc4',
  white: '#d7d2c6',

  brightBlack: TERMINAL_DIM,
  brightRed: '#f0a08c',
  brightGreen: '#8fd0ba',
  brightYellow: '#e4c888',
  brightBlue: '#a8bcd4',
  brightMagenta: '#d0aed6',
  brightCyan: '#a2d6da',
  brightWhite: '#f4f1e8'
}
