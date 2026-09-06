import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { expect, it, vi } from 'vitest'
import { startMcpServer, type RegisteredWorkspace } from '@main/mcp/server'
import { createWorkspaceManager } from './WorkspaceManager'
import { FakePty, FakeRegistry, FakeWindows, fakeSeed, fakeSpawn, fakeWorktrees, sequentialIds, testProfile, testProviders } from './testing'

it('restarts a stopped lead with a private queue and its original budget over real MCP', async () => {
  const mcp = await startMcpServer()
  const register = mcp.registerWorkspace.bind(mcp)
  let registered!: RegisteredWorkspace
  vi.spyOn(mcp, 'registerWorkspace').mockImplementation((ctx) => {
    registered = register(ctx)
    registered.waitForSession = async () => true
    return registered
  })
  const trees = fakeWorktrees()
  const manager = createWorkspaceManager({
    mcp, registry: new FakeRegistry(), windows: new FakeWindows(), providers: testProviders(),
    configDir: '/config', newId: sequentialIds('lead-restart'), createPty: () => new FakePty(),
    spawn: fakeSpawn({ ptySystemPrompt: true }).spawn, seed: fakeSeed().seed,
    createWorktree: trees.createWorktree, readTokenUsage: async () => undefined,
    preflightSeat: async () => undefined,
    worktreeDeps: { git: async (args) => ({ stdout: args[0] === 'rev-parse' ? 'a'.repeat(40) : '', stderr: '' }) }
  })
  const clients: Client[] = []
  const connect = async (url: string) => {
    const client = new Client({ name: 'lead-restart-test', version: '1' })
    clients.push(client)
    await client.connect(new StreamableHTTPClientTransport(new URL(url)))
    return client
  }
  const invoke = async (client: Client, name: string, args: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: args })
    const content = result.content as Array<{ type: string; text?: string }>
    return JSON.parse(content.find((item) => item.type === 'text')!.text!) as Record<string, unknown>
  }
  try {
    const { workspace } = await manager.startWorkspace(testProfile({ maxSubagents: 10, slots: [
      { id: 'worker', roleId: 'worker', providerId: 'claude', maxCount: 8 },
      { id: 'reviewer', roleId: 'reviewer', providerId: 'claude', maxCount: 8 }
    ] }))
    const root = await connect(registered.orchestratorUrl)
    const lead = await invoke(root, 'start_orchestrator', { area: 'parser', task: 'Own parser', maxSubagents: 1 })
    const leadId = String(lead.agentId)
    const oldLead = await connect(registered.leadUrl(leadId))
    const child = await invoke(oldLead, 'start_agent', { role: 'worker', task: 'Parser' })
    const childId = String(child.agentId)
    await vi.waitFor(() => expect(workspace.listAgents().find((agent) => agent.agentId === childId)?.status).toBe('working'))
    const previousQueue = registered.runtime.leads.get(leadId)!.events
    await invoke(root, 'stop_agent', { agentId: leadId })
    expect(previousQueue.isClosed).toBe(true)
    expect(registered.runtime.leads.has(leadId)).toBe(false)
    expect(registered.runtime.parentOf.has(childId)).toBe(false)
    const created = vi.spyOn(registered.runtime, 'onLeadCreated')
    await workspace.reseatAgent({ agentId: leadId, providerId: 'codex' }).ready
    const restored = registered.runtime.leads.get(leadId)!
    expect(restored.events).not.toBe(previousQueue)
    expect(restored.maxSubagents).toBe(1)
    expect(created).toHaveBeenCalledOnce()
    expect(registered.runtime.parentOf.has(childId)).toBe(false)
    registered.runtime.ctx.events.push({ type: 'user_message', text: 'root-only message' })
    restored.events.push({ type: 'agent_progress', agentId: childId, name: 'test', roleId: 'worker', note: 'private lead event' })
    const freshLead = await connect(registered.leadUrl(leadId))
    const events = await invoke(freshLead, 'await_events', { cursor: 0, timeoutSec: 1 })
    expect(JSON.stringify(events)).toContain('private lead event')
    expect(JSON.stringify(events)).not.toContain('root-only message')
    const nestedChild = await invoke(freshLead, 'start_agent', { role: 'worker', task: 'New child' })
    const exceeded = await invoke(freshLead, 'start_agent', { role: 'reviewer', task: 'Over budget' })
    expect(exceeded).toMatchObject({ error: 'limit_exceeded', scope: 'subtree', max: 1 })
    const nestedId = String(nestedChild.agentId)
    await vi.waitFor(() => expect(workspace.listAgents().find((agent) => agent.agentId === nestedId)?.status).toBe('working'))
    const nestedUrl = registered.subagentUrl(nestedId)
    await invoke(freshLead, 'stop_agent', { agentId: nestedId })
    const nestedStatus = (await fetch(nestedUrl)).status
    const worker = await connect(registered.subagentUrl(childId))
    const helper = await invoke(worker, 'start_agent', { role: 'reviewer', task: 'Review parser' })
    const helperId = String(helper.agentId)
    await vi.waitFor(() => expect(workspace.listAgents().find((agent) => agent.agentId === helperId)?.status).toBe('working'))
    const helperUrl = registered.subagentUrl(helperId)
    await invoke(worker, 'stop_agent', { agentId: helperId })
    const helperStatus = (await fetch(helperUrl)).status
    expect([nestedStatus, helperStatus]).toEqual([401, 401])
    // Live reseat keeps the existing queue and subscriptions intact.
    registered.runtime.questions.create(leadId, 'Pause for model switch')
    await workspace.reseatAgent({ agentId: leadId, providerId: 'claude' }).ready
    expect(registered.runtime.leads.get(leadId)).toBe(restored)
    expect(created).toHaveBeenCalledTimes(2) // Restored lead plus the worker helper queue.
    // Failed cutover revocation closes the restored runtime and frees its schema.
    const lastLeadUrl = registered.leadUrl(leadId)
    registered.runtime.resultSchemas.set(leadId, { type: 'object' })
    registered.revokeSubagentToken(leadId, 'lead')
    expect(restored.events.isClosed).toBe(true)
    expect(registered.runtime.leads.has(leadId)).toBe(false)
    expect(registered.runtime.resultSchemas.has(leadId)).toBe(false)
    expect((await fetch(lastLeadUrl)).status).toBe(401)
  } finally {
    await Promise.all(clients.map((client) => client.close()))
    await manager.stopAll()
    await mcp.close()
  }
}, 15_000)
