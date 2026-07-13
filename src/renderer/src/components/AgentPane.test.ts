import { describe, expect, it } from 'vitest'
import { isAgentTerminalChunk } from './terminalStream'

describe('isAgentTerminalChunk', () => {
  it('accepts continuous output from its own PTY', () => {
    const output = ['first chunk', 'progress update', 'final chunk']
    expect(output.every(() => isAgentTerminalChunk('agent-a', 'agent-a'))).toBe(true)
  })

  it('rejects another agent\'s terminal output', () => {
    expect(isAgentTerminalChunk('agent-a', 'agent-b')).toBe(false)
  })
})
