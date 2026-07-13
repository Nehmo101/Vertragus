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

/** xterm.js theme matching the terminal design tokens. */
export const XTERM_THEME = {
  background: '#22190f',
  foreground: '#ece0cb',
  cursor: '#f0a86a',
  cursorAccent: '#22190f',
  selectionBackground: 'rgba(240,168,106,0.28)',
  black: '#140f0a',
  red: '#d9735c',
  green: '#a9c483',
  yellow: '#e6b45f',
  blue: '#f0a86a',
  magenta: '#e79a58',
  cyan: '#a9c483',
  white: '#ece0cb',
  brightBlack: '#93856b',
  brightRed: '#f0a08c',
  brightGreen: '#b6d38f',
  brightYellow: '#f0c885',
  brightBlue: '#ffca9f',
  brightMagenta: '#f0a86a',
  brightCyan: '#cbdbb1',
  brightWhite: '#f3e8d5'
}
