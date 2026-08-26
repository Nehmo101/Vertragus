import { describe, expect, it } from 'vitest'
import {
  bootOverlayClickThrough,
  bootOverlayVisible,
  bootStatusVisible,
  isTerminalBootPhase,
  TERMINAL_BOOT_PHASES
} from './terminalBoot'

describe('terminal boot overlay', () => {
  it('lists every phase the renderer has a string for', () => {
    expect(TERMINAL_BOOT_PHASES).toEqual([
      'preparing',
      'worktree',
      'mcp',
      'cli',
      'handshake',
      'waiting'
    ])
  })

  it('shows the full overlay only while waiting for a late MCP session', () => {
    expect(bootOverlayVisible('waiting')).toBe(true)
    for (const phase of TERMINAL_BOOT_PHASES) {
      if (phase === 'waiting') continue
      expect(bootOverlayVisible(phase)).toBe(false)
    }
    expect(bootOverlayVisible(null)).toBe(false)
    expect(bootOverlayVisible(undefined)).toBe(false)
  })

  it('shows a compact titlebar status for live-xterm phases, not for waiting or a cleared boot', () => {
    for (const phase of ['preparing', 'worktree', 'mcp', 'cli', 'handshake'] as const) {
      expect(bootStatusVisible(phase)).toBe(true)
      expect(bootOverlayVisible(phase)).toBe(false)
    }
    expect(bootStatusVisible('waiting')).toBe(false)
    expect(bootStatusVisible(null)).toBe(false)
    expect(bootStatusVisible(undefined)).toBe(false)
  })

  it('never shows overlay and titlebar status at the same time', () => {
    for (const phase of [...TERMINAL_BOOT_PHASES, null, undefined]) {
      expect(Boolean(bootOverlayVisible(phase) && bootStatusVisible(phase))).toBe(false)
    }
  })

  it('lets clicks through only while waiting on a late MCP session', () => {
    expect(bootOverlayClickThrough('waiting')).toBe(true)
    expect(bootOverlayClickThrough('handshake')).toBe(false)
    expect(bootOverlayClickThrough(null)).toBe(false)
  })

  it('rejects unknown phase ids', () => {
    expect(isTerminalBootPhase('preparing')).toBe(true)
    expect(isTerminalBootPhase('waiting')).toBe(true)
    expect(isTerminalBootPhase('ready')).toBe(false)
    expect(isTerminalBootPhase('')).toBe(false)
    expect(isTerminalBootPhase(null)).toBe(false)
  })
})
