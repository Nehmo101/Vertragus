import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import {
  buildOrchestratorUrl,
  buildSubagentUrl,
  MCP_SERVER_NAME,
  resolveIdentity,
  startMcpServer,
  type McpServerHandle
} from './server'
import { ORCHESTRATOR_TOOL_NAMES } from './toolsOrchestrator'
import { SUBAGENT_TOOL_NAMES } from './toolsSubagent'
import { fakeRuntime } from './testing'
import type { WorkspaceMcpContext } from './types'

function context(overrides: Partial<WorkspaceMcpContext> = {}): WorkspaceMcpContext {
  return { ...fakeRuntime().ctx, ...overrides }
}

describe('URL builders', () => {
  it('build an orchestrator URL with ws and token only', () => {
    const url = new URL(buildOrchestratorUrl(4000, 'ws-1', 'tok'))
    expect(url.pathname).toBe('/mcp')
    expect(url.host).toBe('127.0.0.1:4000')
    expect(url.searchParams.get('ws')).toBe('ws-1')
    expect(url.searchParams.get('token')).toBe('tok')
    expect(url.searchParams.get('agent')).toBeNull()
  })

  it('build a subagent URL that carries the fixed agent identity', () => {
    const url = new URL(buildSubagentUrl(4000, 'ws-1', 'agent-9', 'sub'))
    expect(url.searchParams.get('agent')).toBe('agent-9')
    expect(url.searchParams.get('token')).toBe('sub')
  })

  it('escape ids and tokens', () => {
    const url = new URL(buildOrchestratorUrl(1, 'a b&c', 'x=y'))
    expect(url.searchParams.get('ws')).toBe('a b&c')
    expect(url.searchParams.get('token')).toBe('x=y')
  })
})

describe('resolveIdentity', () => {
  const ctx = context({ workspaceId: 'ws-1', orchToken: 'orch', subToken: 'sub' })
  const lookup = (id: string): WorkspaceMcpContext | undefined => (id === 'ws-1' ? ctx : undefined)
  const params = (query: string): URLSearchParams => new URLSearchParams(query)

  it('accepts the orchestrator token without an agent', () => {
    expect(resolveIdentity(params('ws=ws-1&token=orch'), lookup)).toEqual({
      kind: 'orchestrator',
      workspaceId: 'ws-1'
    })
  })

  it('accepts the subagent token with an agent and fixes the identity', () => {
    expect(resolveIdentity(params('ws=ws-1&agent=a7&token=sub'), lookup)).toEqual({
      kind: 'subagent',
      workspaceId: 'ws-1',
      agentId: 'a7'
    })
  })

  it('refuses a subagent token on an orchestrator URL', () => {
    expect(resolveIdentity(params('ws=ws-1&token=sub'), lookup)).toBeUndefined()
  })

  it('refuses an orchestrator token on a subagent URL', () => {
    expect(resolveIdentity(params('ws=ws-1&agent=a7&token=orch'), lookup)).toBeUndefined()
  })

  it('refuses a missing token, a wrong token, a missing ws and an unknown ws', () => {
    expect(resolveIdentity(params('ws=ws-1'), lookup)).toBeUndefined()
    expect(resolveIdentity(params('ws=ws-1&token=nope'), lookup)).toBeUndefined()
    expect(resolveIdentity(params('token=orch'), lookup)).toBeUndefined()
    expect(resolveIdentity(params('ws=other&token=orch'), lookup)).toBeUndefined()
  })

  it('refuses a token that is merely a prefix of the real one', () => {
    expect(resolveIdentity(params('ws=ws-1&token=orc'), lookup)).toBeUndefined()
  })
})

describe('startMcpServer', () => {
  let handle: McpServerHandle

  beforeEach(async () => {
    handle = await startMcpServer()
  })
  afterEach(async () => {
    await handle.close()
  })

  async function connect(url: string): Promise<Client> {
    const client = new Client({ name: 'test', version: '1.0.0' })
    await client.connect(new StreamableHTTPClientTransport(new URL(url)))
    return client
  }

  /** The SDK reports the HTTP status on the error's `code`, not in its message. */
  async function expectUnauthorized(url: string): Promise<void> {
    await expect(connect(url)).rejects.toMatchObject({ code: 401 })
  }

  it('listens on a random loopback port', () => {
    expect(handle.port).toBeGreaterThan(0)
    expect(buildOrchestratorUrl(handle.port, 'x', 'y')).toContain('http://127.0.0.1:')
  })

  it('serves the seven orchestrator tools on an orchestrator URL', async () => {
    const registered = handle.registerWorkspace(context({ workspaceId: 'w1' }))
    const client = await connect(registered.orchestratorUrl)
    const tools = (await client.listTools()).tools.map((tool) => tool.name).sort()
    expect(tools).toEqual([...ORCHESTRATOR_TOOL_NAMES].sort())
    await client.close()
  })

  it('serves only the three subagent tools on a subagent URL', async () => {
    const registered = handle.registerWorkspace(context({ workspaceId: 'w2' }))
    const client = await connect(registered.subagentUrl('agent-1'))
    const tools = (await client.listTools()).tools.map((tool) => tool.name).sort()
    expect(tools).toEqual([...SUBAGENT_TOOL_NAMES].sort())
    await client.close()
  })

  it('rejects a wrong token with 401', async () => {
    handle.registerWorkspace(context({ workspaceId: 'w3', orchToken: 'right' }))
    await expectUnauthorized(buildOrchestratorUrl(handle.port, 'w3', 'wrong'))
  })

  it('rejects an unknown workspace with 401', async () => {
    await expectUnauthorized(buildOrchestratorUrl(handle.port, 'ghost', 'x'))
  })

  it('rejects the subagent token used for an orchestrator session', async () => {
    const ctx = context({ workspaceId: 'w4' })
    handle.registerWorkspace(ctx)
    await expectUnauthorized(buildOrchestratorUrl(handle.port, 'w4', ctx.subToken))
  })

  it('refuses to register the same workspace twice', () => {
    handle.registerWorkspace(context({ workspaceId: 'w5' }))
    expect(() => handle.registerWorkspace(context({ workspaceId: 'w5' }))).toThrow(/already/)
  })

  it('stops serving a workspace after unregister and closes its queue', async () => {
    const ctx = context({ workspaceId: 'w6' })
    const registered = handle.registerWorkspace(ctx)
    handle.unregisterWorkspace('w6')

    expect(ctx.events.isClosed).toBe(true)
    await expectUnauthorized(registered.orchestratorUrl)
    expect(() => handle.orchestratorUrl('w6')).toThrow(/Unknown MCP workspace/)
  })

  it('ignores unregistering an unknown workspace', () => {
    expect(() => handle.unregisterWorkspace('never-there')).not.toThrow()
  })

  it('builds both URLs for a registered workspace from the handle', () => {
    const ctx = context({ workspaceId: 'w7' })
    handle.registerWorkspace(ctx)
    expect(handle.orchestratorUrl('w7')).toContain(`ws=w7&token=${ctx.orchToken}`)
    expect(handle.subagentUrl('w7', 'a1')).toContain('agent=a1')
    expect(() => handle.subagentUrl('nope', 'a1')).toThrow(/Unknown MCP workspace/)
  })

  it('names itself vertragus so tools resolve as mcp__vertragus__*', async () => {
    const registered = handle.registerWorkspace(context({ workspaceId: 'w8' }))
    const client = await connect(registered.orchestratorUrl)
    expect(client.getServerVersion()?.name).toBe(MCP_SERVER_NAME)
    await client.close()
  })

  it('404s any path that is not /mcp', async () => {
    const response = await fetch(`http://127.0.0.1:${handle.port}/nope`)
    expect(response.status).toBe(404)
  })

  it('401s before it even looks at the method', async () => {
    const response = await fetch(`http://127.0.0.1:${handle.port}/mcp`, { method: 'PUT' })
    expect(response.status).toBe(401)
  })

  it('405s an unsupported method on an authorised URL', async () => {
    const registered = handle.registerWorkspace(context({ workspaceId: 'w9' }))
    const response = await fetch(registered.orchestratorUrl, { method: 'PUT' })
    expect(response.status).toBe(405)
  })

  it('400s a POST without a session that is not an initialize request', async () => {
    const registered = handle.registerWorkspace(context({ workspaceId: 'w10' }))
    const response = await fetch(registered.orchestratorUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
    })
    expect(response.status).toBe(400)
  })
})
