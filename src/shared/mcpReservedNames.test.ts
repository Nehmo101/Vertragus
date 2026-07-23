import { describe, expect, it } from 'vitest'
import {
  emptyMcpServer,
  isMcpServerComplete,
  isReservedMcpServerName,
  mcpServerSchema,
  RESERVED_MCP_SERVER_NAMES
} from './mcp'

describe('reserved MCP server names', () => {
  it.each([...RESERVED_MCP_SERVER_NAMES])('rejects "%s" at schema level', (name) => {
    const server = { ...emptyMcpServer('id-1'), name, command: 'npx' }
    expect(mcpServerSchema.safeParse(server).success).toBe(false)
  })

  it('rejects reserved names case-insensitively', () => {
    expect(isReservedMcpServerName('Vertragus')).toBe(true)
    expect(isReservedMcpServerName('ORCA')).toBe(true)
    const server = { ...emptyMcpServer('id-1'), name: 'Orca', command: 'npx' }
    expect(mcpServerSchema.safeParse(server).success).toBe(false)
  })

  it('treats a stored reserved-name server as incomplete (launch-time defense)', () => {
    // Pre-validation stores may still carry such an entry; it must never be
    // attached, or it would shadow the internal orchestrator server.
    const server = { ...emptyMcpServer('id-1'), name: 'orca', command: 'npx' }
    expect(isMcpServerComplete(server)).toBe(false)
  })

  it('still accepts ordinary user server names', () => {
    const server = { ...emptyMcpServer('id-1'), name: 'filesystem', command: 'npx' }
    expect(mcpServerSchema.safeParse(server).success).toBe(true)
    expect(isMcpServerComplete(server)).toBe(true)
  })
})
