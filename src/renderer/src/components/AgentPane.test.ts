import { describe, expect, it, vi } from 'vitest'
import { isAgentTerminalChunk } from './terminalStream'

const hookMocks = vi.hoisted(() => ({
  useEffect: vi.fn(),
  useRef: vi.fn((initial: unknown) => ({ current: initial }))
}))

vi.mock('react', async () => {
  const actual = await vi.importActual<typeof import('react')>('react')
  return { ...actual, useEffect: hookMocks.useEffect, useRef: hookMocks.useRef }
})
vi.mock('@xterm/xterm', () => ({ Terminal: class Terminal {} }))
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class FitAddon {} }))

import { useAgentTerminal } from './AgentPane'

describe('AgentPane terminal isolation', () => {
  it('accepts continuous output only from its own PTY', () => {
    const output = ['first chunk', 'progress update', 'final chunk']
    expect(output.every(() => isAgentTerminalChunk('agent-a', 'agent-a'))).toBe(true)
    expect(isAgentTerminalChunk('agent-a', 'agent-b')).toBe(false)
  })

  it('keys the xterm lifecycle only to the agent id', () => {
    hookMocks.useEffect.mockClear()
    hookMocks.useRef.mockClear()

    useAgentTerminal('agent-a', true)

    expect(hookMocks.useEffect.mock.calls.map((call) => call[1])).toEqual([
      [true],
      ['agent-a']
    ])
  })
})
