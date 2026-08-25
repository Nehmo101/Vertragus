import { describe, expect, it } from 'vitest'
import {
  bootOverlayClickThrough,
  bootOverlayVisible,
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

  it('shows the overlay for every phase and hides it when the host clears the phase', () => {
    for (const phase of TERMINAL_BOOT_PHASES) {
      expect(bootOverlayVisible(phase)).toBe(true)
    }
    expect(bootOverlayVisible(null)).toBe(false)
    expect(bootOverlayVisible(undefined)).toBe(false)
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
