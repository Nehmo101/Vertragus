import { describe, expect, it, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { DEFAULT_PROFILE } from '@shared/profile'

vi.mock('electron', () => ({
  app: { getPath: () => '.', getName: () => 'test', isPackaged: false },
  BrowserWindow: class {},
  shell: { openExternal: vi.fn() }
}))
vi.mock('@main/windows', () => ({ createPaneWindow: vi.fn(), broadcast: vi.fn() }))
vi.mock('@main/config/store', () => ({
  getProfile: () => DEFAULT_PROFILE,
  getActiveProfileId: () => 'default',
  getSetting: () => undefined,
  setSetting: vi.fn()
}))
vi.mock('@main/agents/AgentManager', () => ({
  agentManager: { runTask: vi.fn(), kill: vi.fn(), list: () => [] }
}))

import { buildMcpServer, ORCHESTRATOR_TOOL_NAMES } from './VertragusMcpServer'
import { ORCHESTRATOR_MCP_SERVER_NAME } from './mcpHandle'

describe('orchestrator MCP tool surface', () => {
  it('registers exactly the tools promised by ORCHESTRATOR_TOOL_NAMES', async () => {
    // A registered-but-unlisted tool would be launched without an allowlist
    // entry and thus be invisible to strict-allowlist providers (the
    // await_plan_approval bug); a listed-but-unregistered tool would be
    // prompted but fail at call time. Both directions must stay in sync.
    const server = buildMcpServer()
    const client = new Client({ name: 'tool-surface-test', version: '0.0.1' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    await client.connect(clientTransport)

    const listed = await client.listTools()
    const registered = listed.tools.map((tool) => tool.name).sort()
    expect(registered).toEqual([...ORCHESTRATOR_TOOL_NAMES].sort())

    await client.close()
    await server.close()
  })

  it('uses the vertragus namespace for the launch allowlist', () => {
    expect(ORCHESTRATOR_MCP_SERVER_NAME).toBe('vertragus')
    expect(ORCHESTRATOR_TOOL_NAMES).toContain('await_plan_approval')
  })
})
