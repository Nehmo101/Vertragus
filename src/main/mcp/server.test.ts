import { request as httpRequest } from 'node:http'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import {
  buildOrchestratorUrl,
  buildSubagentUrl,
  isAllowedHostHeader,
  isAllowedOrigin,
  leadToken,
  MCP_SERVER_NAME,
  resolveIdentity,
  startMcpServer,
  subagentToken,
  type McpServerHandle
} from './server'
import { EventQueue } from './eventQueue'
import { LEAD_TOOL_NAMES, ORCHESTRATOR_TOOL_NAMES } from './toolsOrchestrator'
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

  it('build a subagent URL that carries the fixed agent identity and a per-agent token', () => {
    const url = new URL(buildSubagentUrl(4000, 'ws-1', 'agent-9', 'sub'))
    expect(url.searchParams.get('agent')).toBe('agent-9')
    // Never the raw workspace secret: the URL lands in the agent's own config
    // files, and what leaks from there must open exactly one identity.
    expect(url.searchParams.get('token')).toBe(subagentToken('sub', 'agent-9'))
    expect(url.searchParams.get('token')).not.toBe('sub')
    expect(new URL(buildSubagentUrl(4000, 'ws-1', 'agent-8', 'sub')).searchParams.get('token')).not.toBe(
      url.searchParams.get('token')
    )
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

  it('accepts the per-agent token with its own agent and fixes the identity', () => {
    expect(
      resolveIdentity(params(`ws=ws-1&agent=a7&token=${subagentToken('sub', 'a7')}`), lookup)
    ).toEqual({
      kind: 'subagent',
      workspaceId: 'ws-1',
      agentId: 'a7'
    })
  })

  it('refuses a sibling impersonation — one agent’s token under another agent’s id', () => {
    expect(
      resolveIdentity(params(`ws=ws-1&agent=a8&token=${subagentToken('sub', 'a7')}`), lookup)
    ).toBeUndefined()
  })

  it('refuses the raw workspace secret as a subagent token', () => {
    expect(resolveIdentity(params('ws=ws-1&agent=a7&token=sub'), lookup)).toBeUndefined()
  })

  it('refuses a subagent token on an orchestrator URL', () => {
    expect(resolveIdentity(params('ws=ws-1&token=sub'), lookup)).toBeUndefined()
    expect(
      resolveIdentity(params(`ws=ws-1&token=${subagentToken('sub', 'a7')}`), lookup)
    ).toBeUndefined()
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

describe('DNS-rebinding defence', () => {
  it('allows loopback and the configured bind host, refuses everything else', () => {
    expect(isAllowedHostHeader('127.0.0.1:5123', '127.0.0.1')).toBe(true)
    expect(isAllowedHostHeader('localhost:5123', '127.0.0.1')).toBe(true)
    expect(isAllowedHostHeader('[::1]:5123', '127.0.0.1')).toBe(true)
    // A rebound attacker hostname resolves to 127.0.0.1 but still names itself.
    expect(isAllowedHostHeader('evil.example:5123', '127.0.0.1')).toBe(false)
    expect(isAllowedHostHeader(undefined, '127.0.0.1')).toBe(false)
    // Tests may bind a custom host; that host is then legitimate.
    expect(isAllowedHostHeader('10.0.0.5:5123', '10.0.0.5')).toBe(true)
  })

  it('treats a missing Origin as a non-browser client and a foreign one as an attack', () => {
    expect(isAllowedOrigin(undefined, '127.0.0.1')).toBe(true)
    expect(isAllowedOrigin('http://127.0.0.1:5123', '127.0.0.1')).toBe(true)
    expect(isAllowedOrigin('http://localhost:5123', '127.0.0.1')).toBe(true)
    expect(isAllowedOrigin('https://evil.example', '127.0.0.1')).toBe(false)
    expect(isAllowedOrigin('null', '127.0.0.1')).toBe(false)
    expect(isAllowedOrigin('not a url', '127.0.0.1')).toBe(false)
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

  it('serves the eleven orchestrator tools on an orchestrator URL', async () => {
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

  it('exposes open questions with ids and answers them on the shared path (H1)', async () => {
    const registered = handle.registerWorkspace(context({ workspaceId: 'w-answer' }))
    const pending = registered.runtime.questions.create('agent-1', 'Which DB?')
    const waiter = registered.runtime.questions.waitForAnswer(pending.questionId, 'agent-1', 5_000)

    expect(handle.openQuestion('w-answer', 'agent-1')).toEqual({
      questionId: pending.questionId,
      question: 'Which DB?'
    })
    expect(handle.openQuestion('w-answer', 'ghost')).toBeUndefined()
    expect(handle.openQuestion('ghost', 'agent-1')).toBeUndefined()

    await expect(handle.answerQuestion('ghost', 'agent-1', pending.questionId, 'x')).resolves.toEqual({
      ok: false,
      error: 'unknown_workspace',
      questionId: pending.questionId
    })
    await expect(
      handle.answerQuestion('w-answer', 'agent-1', pending.questionId, 'Postgres.')
    ).resolves.toEqual({ ok: true, agentId: 'agent-1', questionId: pending.questionId })
    await expect(waiter).resolves.toEqual({ state: 'answered', answer: 'Postgres.' })
    expect(handle.openQuestion('w-answer', 'agent-1')).toBeUndefined()
  })

  it('F: serves the lead tool union on a lead URL and keeps the token domains apart', async () => {
    const ctx = context({ workspaceId: 'w-lead' })
    const registered = handle.registerWorkspace(ctx)

    const client = await connect(registered.leadUrl('lead-1'))
    const tools = (await client.listTools()).tools.map((tool) => tool.name).sort()
    expect(tools).toEqual([...LEAD_TOOL_NAMES].sort())
    // Root-only surface is absent, upward reporting present.
    expect(tools).not.toContain('start_orchestrator')
    expect(tools).not.toContain('record_retro')
    expect(tools).toContain('report_done')
    await client.close()

    // A lead token never opens the subagent identity of the same id or vice versa.
    expect(leadToken(ctx.subToken, 'lead-1')).not.toBe(subagentToken(ctx.subToken, 'lead-1'))
    await expectUnauthorized(
      `${registered.leadUrl('lead-1').split('?')[0]}?ws=w-lead&lead=lead-1&token=${subagentToken(ctx.subToken, 'lead-1')}`
    )
    await expectUnauthorized(
      `${registered.leadUrl('lead-1').split('?')[0]}?ws=w-lead&agent=lead-1&token=${leadToken(ctx.subToken, 'lead-1')}`
    )
  })

  it('F: a dead lead’s children are adopted when its exit lands in the root queue', () => {
    const ctx = context({ workspaceId: 'w-adopt' })
    const registered = handle.registerWorkspace(ctx)
    const runtime = registered.runtime
    runtime.leads.set('lead-1', {
      agentId: 'lead-1',
      area: 'payments',
      events: new EventQueue()
    })
    runtime.parentOf.set('child-1', 'lead-1')

    ctx.events.push({
      type: 'agent_exited',
      agentId: 'lead-1',
      name: 'Virgilio',
      roleId: 'lead',
      exitCode: 1,
      confirmed: false
    })

    expect(runtime.leads.has('lead-1')).toBe(false)
    expect(runtime.parentOf.has('child-1')).toBe(false)
    expect(
      ctx.events.all().filter((event) => event.type === 'subtree_adopted')
    ).toHaveLength(1)
  })

  it('names itself vertragus so tools resolve as mcp__vertragus__*', async () => {
    const registered = handle.registerWorkspace(context({ workspaceId: 'w8' }))
    const client = await connect(registered.orchestratorUrl)
    expect(client.getServerVersion()?.name).toBe(MCP_SERVER_NAME)
    await client.close()
  })

  it('403s a request whose Host is not loopback — before identity even runs', async () => {
    // fetch strips the forbidden Host header, so speak raw HTTP.
    const registered = handle.registerWorkspace(context({ workspaceId: 'w-host' }))
    const target = new URL(registered.orchestratorUrl)
    const status = await new Promise<number>((resolve, reject) => {
      const request = httpRequest(
        {
          host: '127.0.0.1',
          port: handle.port,
          path: `${target.pathname}${target.search}`,
          method: 'POST',
          headers: { Host: 'evil.example', 'Content-Type': 'application/json' }
        },
        (response) => {
          response.resume()
          resolve(response.statusCode ?? 0)
        }
      )
      request.on('error', reject)
      request.end('{}')
    })
    expect(status).toBe(403)
  })

  it('403s a browser request with a foreign Origin even with a valid token', async () => {
    const registered = handle.registerWorkspace(context({ workspaceId: 'w-origin' }))
    const response = await fetch(registered.orchestratorUrl, {
      method: 'POST',
      headers: { Origin: 'https://evil.example', 'Content-Type': 'application/json' },
      body: '{}'
    })
    expect(response.status).toBe(403)
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
