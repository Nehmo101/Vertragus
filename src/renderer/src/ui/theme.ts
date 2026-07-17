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
  label: string
}

export const STATUS_THEME: Record<AgentStatus, StatusTheme> = {
  running: { dot: 'var(--run)', text: 'var(--run-text)', label: 'läuft' },
  waiting: { dot: 'var(--wait)', text: 'var(--wait-text)', label: 'wartet' },
  error: { dot: 'var(--err)', text: 'var(--err-text)', label: 'Fehler' },
  stopped: { dot: 'var(--stop)', text: 'var(--stop-text)', label: 'gestoppt' }
}

/**
 * xterm.js theme mirroring the dark design tokens in cozy-organic.css
 * (xterm needs concrete values, not CSS variables). Palette-Regel aus
 * docs/BRAND.md: Bronze für Akzente, Verdigris für Lauf-Zustände; die
 * ANSI-Slots blau/magenta bleiben bewusst in der warmen Farbwelt.
 */
export const XTERM_THEME = {
  background: '#14171c',
  foreground: '#eae6db',
  cursor: '#cba35a',
  cursorAccent: '#14171c',
  selectionBackground: 'rgba(203,163,90,0.28)',
  black: '#0d1015',
  red: '#d9735c',
  green: '#3e9d82',
  yellow: '#e29b4b',
  blue: '#cba35a',
  magenta: '#f0a068',
  cyan: '#7fb8a6',
  white: '#eae6db',
  brightBlack: '#7c7a70',
  brightRed: '#f0a08c',
  brightGreen: '#8fd0ba',
  brightYellow: '#f0c08a',
  brightBlue: '#e4c888',
  brightMagenta: '#f0dcaf',
  brightCyan: '#a9d6c9',
  brightWhite: '#f5f1e6'
}
