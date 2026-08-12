/**
 * Test-only helpers for the MCP layer. Nothing in `src/main` imports this at
 * runtime — it exists so the tool tests can call a tool exactly the way the MCP
 * SDK would (schema validation included) without an HTTP round trip.
 */
import { z, type ZodRawShape } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { EventQueue } from './eventQueue'
import { PendingQuestions } from './pendingQuestions'
import type {
  AgentHost,
  AgentSummary,
  StartAgentInput,
  StartedAgent,
  ToolText,
  WorkspaceMcpContext,
  WorkspaceRuntime
} from './types'

export interface CapturedTool {
  name: string
  description?: string
  inputSchema: ZodRawShape
  handler: (args: Record<string, unknown>) => Promise<ToolText>
}

/** Run a `register*Tools` function against a recorder instead of a real server. */
export function captureTools(register: (server: McpServer) => void): Map<string, CapturedTool> {
  const tools = new Map<string, CapturedTool>()
  const recorder = {
    registerTool(
      name: string,
      config: { description?: string; inputSchema?: ZodRawShape },
      handler: (args: Record<string, unknown>) => Promise<ToolText>
    ) {
      tools.set(name, {
        name,
        description: config.description,
        inputSchema: config.inputSchema ?? {},
        handler
      })
      return undefined
    }
  }
  register(recorder as unknown as McpServer)
  return tools
}

/** Call a captured tool through its own schema, like the SDK does. */
export async function callTool(
  tools: Map<string, CapturedTool>,
  name: string,
  args: Record<string, unknown> = {}
): Promise<{ isError: boolean; text: string; json: Record<string, unknown> }> {
  const tool = tools.get(name)
  if (!tool) throw new Error(`Tool not registered: ${name}`)
  const parsed = z.object(tool.inputSchema).parse(args)
  const result = await tool.handler(parsed as Record<string, unknown>)
  const text = result.content.map((part) => part.text).join('')
  let json: Record<string, unknown> = {}
  try {
    const candidate: unknown = JSON.parse(text)
    if (candidate && typeof candidate === 'object') json = candidate as Record<string, unknown>
  } catch {
    json = {}
  }
  return { isError: result.isError === true, text, json }
}

export interface FakeHostOptions {
  /** Called instead of the default bookkeeping when an agent is started. */
  onStart?: (input: StartAgentInput, agent: AgentSummary) => void
  startError?: string
}

/** An in-memory {@link AgentHost}: no processes, no windows, full bookkeeping. */
export class FakeAgentHost implements AgentHost {
  readonly agents = new Map<string, AgentSummary>()
  readonly sent: Array<{ agentId: string; text: string }> = []
  readonly seeded: Array<{ agentId: string; task: string }> = []
  output = new Map<string, string>()
  private counter = 0

  constructor(private readonly options: FakeHostOptions = {}) {}

  async startAgent(input: StartAgentInput): Promise<StartedAgent> {
    if (this.options.startError) throw new Error(this.options.startError)
    const agentId = `agent-${++this.counter}`
    // Every agent gets its own worktree — the fake mirrors the invariant.
    const worktreePath = `/tmp/worktrees/${agentId}`
    const agent: AgentSummary = {
      agentId,
      name: `Agent ${this.counter}`,
      role: input.role,
      status: 'running',
      model: input.model,
      worktreePath,
      lastOutputAgeSec: 0
    }
    this.agents.set(agentId, agent)
    this.seeded.push({ agentId, task: input.task })
    this.options.onStart?.(input, agent)
    return {
      agentId,
      name: agent.name,
      role: agent.role,
      worktreePath
    }
  }

  async sendToAgent(agentId: string, text: string): Promise<void> {
    if (!this.agents.has(agentId)) throw new Error(`Unknown agent ${agentId}`)
    this.sent.push({ agentId, text })
  }

  async stopAgent(agentId: string): Promise<boolean> {
    const agent = this.agents.get(agentId)
    if (!agent || agent.status === 'stopped') return false
    this.agents.set(agentId, { ...agent, status: 'stopped' })
    return true
  }

  async readOutput(agentId: string, lines: number): Promise<string> {
    if (!this.agents.has(agentId)) throw new Error(`Unknown agent ${agentId}`)
    const all = (this.output.get(agentId) ?? '').split('\n')
    return all.slice(Math.max(0, all.length - lines)).join('\n')
  }

  listAgents(): AgentSummary[] {
    return [...this.agents.values()]
  }
}

export interface FakeRuntimeOptions {
  roles?: string[]
  perRole?: Record<string, number | undefined>
  maxTotal?: number
  askTimeoutMs?: number
  host?: FakeAgentHost
}

/** A workspace runtime wired to a {@link FakeAgentHost}. */
export function fakeRuntime(options: FakeRuntimeOptions = {}): WorkspaceRuntime & {
  host: FakeAgentHost
  events: EventQueue
} {
  const host = options.host ?? new FakeAgentHost()
  const events = new EventQueue()
  const ctx: WorkspaceMcpContext = {
    workspaceId: 'ws-test',
    workspaceName: 'Arsenale',
    repoPath: '/repo',
    orchToken: 'orch-token',
    subToken: 'sub-token',
    host,
    events,
    limits: {
      perRole: new Map(Object.entries(options.perRole ?? {})),
      maxTotal: options.maxTotal
    },
    roles: options.roles ?? ['worker', 'reviewer'],
    askTimeoutMs: options.askTimeoutMs
  }
  return { ctx, questions: new PendingQuestions(), host, events }
}
