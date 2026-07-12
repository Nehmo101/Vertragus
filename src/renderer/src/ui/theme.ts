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
  claude: { label: 'Claude', mono: 'CL', fg: '#e0a17f', bg: 'rgba(224,161,127,0.16)' },
  codex: { label: 'Codex', mono: 'Cx', fg: '#4fd18a', bg: 'rgba(79,209,138,0.15)' },
  cursor: { label: 'Cursor', mono: 'Cu', fg: '#c4b5fd', bg: 'rgba(196,181,253,0.15)' },
  copilot: { label: 'GitHub Copilot', mono: 'Co', fg: '#6cb6ff', bg: 'rgba(108,182,255,0.15)' },
  ollama: { label: 'Ollama', mono: 'Ol', fg: '#cbd5e1', bg: 'rgba(203,213,225,0.13)' },
  github: { label: 'GitHub', mono: 'GH', fg: '#c9d3e0', bg: 'rgba(201,211,224,0.12)' },
  cloudflare: { label: 'Cloudflare', mono: 'CF', fg: '#f6a94f', bg: 'rgba(246,169,79,0.15)' }
}

export interface StatusTheme {
  dot: string
  text: string
  label: string
  pulse: string | null
}

export const STATUS_THEME: Record<AgentStatus, StatusTheme> = {
  running: { dot: '#3fd17a', text: '#5fe39a', label: 'läuft', pulse: '1.9s' },
  waiting: { dot: '#e9b949', text: '#f2c85a', label: 'wartet', pulse: '1.3s' },
  error: { dot: '#f2555a', text: '#ff7377', label: 'Fehler', pulse: '1.9s' },
  stopped: { dot: '#5b697f', text: '#7a869a', label: 'gestoppt', pulse: null }
}

/** xterm.js theme matching the terminal design tokens. */
export const XTERM_THEME = {
  background: '#070b12',
  foreground: '#c7d2e0',
  cursor: '#2dd4bf',
  cursorAccent: '#04121a',
  selectionBackground: 'rgba(45,212,191,0.30)',
  black: '#0b1120',
  red: '#f2555a',
  green: '#3fd17a',
  yellow: '#e9b949',
  blue: '#4f9cf2',
  magenta: '#c4b5fd',
  cyan: '#22d3ee',
  white: '#c7d2e0',
  brightBlack: '#5b697f',
  brightRed: '#ff7377',
  brightGreen: '#5fe39a',
  brightYellow: '#f2c85a',
  brightBlue: '#7fb5ff',
  brightMagenta: '#d9ceff',
  brightCyan: '#7fdfff',
  brightWhite: '#e6edf6'
}
