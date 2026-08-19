/**
 * The Vertragus MCP server: one Streamable-HTTP endpoint on 127.0.0.1 for the
 * whole app, serving every workspace.
 *
 * Identity comes from the query string of the URL we hand to the agent process:
 *   /mcp?ws=<workspaceId>&token=<orchToken>                 → orchestrator tools
 *   /mcp?ws=<workspaceId>&agent=<agentId>&token=<agentToken> → subagent tools
 *
 * The subagent token is PER AGENT: an HMAC of the agentId under the workspace's
 * subagent secret ({@link subagentToken}). Flipping the `agent=` parameter
 * therefore invalidates the token — a subagent that can read its own MCP URL
 * (it sits in its worktree's config files, or plainly in argv for Codex)
 * still cannot report as a sibling. The identity is fixed server-side either
 * way, and a subagent token does not open an orchestrator session. Requests
 * whose Host/Origin is not loopback are refused outright (DNS-rebinding
 * defence). Everything else (400/401/403/405) fails closed.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js'
import { PendingQuestions } from './pendingQuestions'
import { registerOrchestratorTools } from './toolsOrchestrator'
import { registerSubagentTools } from './toolsSubagent'
import type { WorkspaceMcpContext, WorkspaceRuntime } from './types'

/** MCP namespace of our tools: `mcp__vertragus__<tool>`. */
export const MCP_SERVER_NAME = 'vertragus'
export const MCP_SERVER_VERSION = '0.1.0'
export const MCP_PATH = '/mcp'
export const MCP_BIND_HOST = '127.0.0.1'

const MAX_REQUEST_BODY_BYTES = 4 * 1024 * 1024

const ORCHESTRATOR_INSTRUCTIONS = [
  'These are the Vertragus orchestration tools for your workspace.',
  'Delegate work with start_agent, then loop on await_events and handle every event.',
  'Verify file changes with inspect_agent, not by reading the terminal.',
  'Answer agent_question events immediately with send_to_agent{questionId}.'
].join(' ')

const SUBAGENT_INSTRUCTIONS = [
  'These are your Vertragus reporting tools.',
  'Call report_done when your task is finished, ask_orchestrator (and wait) when you are blocked,',
  'and report_progress for real milestones. Never end your turn without one of the first two.'
].join(' ')

export type McpIdentity =
  | { kind: 'orchestrator'; workspaceId: string }
  | { kind: 'subagent'; workspaceId: string; agentId: string }

export interface RegisteredWorkspace {
  /**
   * The MCP-owned runtime for this workspace. Callers (WorkspaceManager) must
   * hand `runtime.questions` to the workspace via `attachQuestions` so sentinel
   * ASK lines and MCP `ask_orchestrator` share one registry.
   */
  runtime: WorkspaceRuntime
  orchestratorUrl: string
  subagentUrl(agentId: string): string
}

export interface McpServerHandle {
  port: number
  registerWorkspace(ctx: WorkspaceMcpContext): RegisteredWorkspace
  unregisterWorkspace(workspaceId: string): void
  orchestratorUrl(workspaceId: string): string
  subagentUrl(workspaceId: string, agentId: string): string
  /**
   * Open question text for an agent, if any. The host layer cannot see these —
   * they live only in {@link PendingQuestions}. The panel reads them so a
   * waiting agent can blink without round-tripping through MCP tools.
   */
  pendingQuestion(workspaceId: string, agentId: string): string | undefined
  /**
   * The latest assignment the orchestrator handed out in this workspace,
   * shortened to one line. The panel appends it to the workspace tooltip.
   */
  workspaceTask(workspaceId: string): string | undefined
  close(): Promise<void>
}

function baseUrl(port: number, host: string = MCP_BIND_HOST): string {
  return `http://${host}:${port}${MCP_PATH}`
}

export function buildOrchestratorUrl(
  port: number,
  workspaceId: string,
  orchToken: string,
  host: string = MCP_BIND_HOST
): string {
  const params = new URLSearchParams({ ws: workspaceId, token: orchToken })
  return `${baseUrl(port, host)}?${params.toString()}`
}

/**
 * The per-agent secret: HMAC-SHA256 of the agentId under the workspace's
 * subagent secret. Stateless — the server re-derives it from the URL's
 * `agent=` parameter, so there is no token registry to keep in sync, and a
 * token stolen from one agent's config file opens exactly that one identity.
 */
export function subagentToken(subToken: string, agentId: string): string {
  return createHmac('sha256', subToken).update(agentId).digest('hex')
}

export function buildSubagentUrl(
  port: number,
  workspaceId: string,
  agentId: string,
  subToken: string,
  host: string = MCP_BIND_HOST
): string {
  const params = new URLSearchParams({
    ws: workspaceId,
    agent: agentId,
    token: subagentToken(subToken, agentId)
  })
  return `${baseUrl(port, host)}?${params.toString()}`
}

/** Constant-time string compare that never throws on length mismatch. */
function secretEquals(a: string | null, b: string): boolean {
  if (!a) return false
  const left = Buffer.from(a, 'utf8')
  const right = Buffer.from(b, 'utf8')
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

/**
 * Decide who is calling. Returns undefined for every failure — unknown
 * workspace, wrong token, subagent token on an orchestrator URL — so the caller
 * answers a flat 401 and leaks nothing about which part was wrong.
 */
export function resolveIdentity(
  params: URLSearchParams,
  lookup: (workspaceId: string) => WorkspaceMcpContext | undefined
): McpIdentity | undefined {
  const workspaceId = params.get('ws')
  if (!workspaceId) return undefined
  const ctx = lookup(workspaceId)
  if (!ctx) return undefined
  const token = params.get('token')
  const agentId = params.get('agent')

  if (agentId) {
    // Compare against the token THIS agentId derives to — a sibling's token
    // under a flipped `agent=` parameter fails here.
    return secretEquals(token, subagentToken(ctx.subToken, agentId))
      ? { kind: 'subagent', workspaceId, agentId }
      : undefined
  }
  return secretEquals(token, ctx.orchToken) ? { kind: 'orchestrator', workspaceId } : undefined
}

/**
 * DNS-rebinding defence: a browser that resolved an attacker's hostname to
 * 127.0.0.1 still sends that hostname in `Host` (and its page's `Origin`).
 * Loopback names and the configured bind host are the complete allowlist —
 * agent CLIs connect to the literal URL we hand them and never send `Origin`.
 */
export function isAllowedHostHeader(hostHeader: string | undefined, bindHost: string): boolean {
  if (!hostHeader) return false
  let hostname: string
  try {
    hostname = new URL(`http://${hostHeader}`).hostname
  } catch {
    return false
  }
  return (
    hostname === '127.0.0.1' ||
    hostname === 'localhost' ||
    hostname === '[::1]' ||
    hostname === '::1' ||
    hostname === bindHost
  )
}

export function isAllowedOrigin(origin: string | undefined, bindHost: string): boolean {
  // No Origin header = not a browser context; the Host check already ran.
  if (origin === undefined) return true
  let hostname: string
  try {
    hostname = new URL(origin).hostname
  } catch {
    return false
  }
  return (
    hostname === '127.0.0.1' ||
    hostname === 'localhost' ||
    hostname === '::1' ||
    hostname === bindHost
  )
}

function sameIdentity(a: McpIdentity, b: McpIdentity): boolean {
  if (a.kind !== b.kind || a.workspaceId !== b.workspaceId) return false
  return a.kind !== 'subagent' || a.agentId === (b as { agentId: string }).agentId
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    total += buffer.length
    if (total > MAX_REQUEST_BODY_BYTES) return undefined
    chunks.push(buffer)
  }
  if (chunks.length === 0) return undefined
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    return undefined
  }
}

function buildServerFor(identity: McpIdentity, runtime: WorkspaceRuntime): McpServer {
  const server = new McpServer(
    { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
    {
      instructions:
        identity.kind === 'orchestrator' ? ORCHESTRATOR_INSTRUCTIONS : SUBAGENT_INSTRUCTIONS
    }
  )
  if (identity.kind === 'orchestrator') registerOrchestratorTools(server, runtime)
  else registerSubagentTools(server, runtime, identity.agentId)
  return server
}

interface SessionRecord {
  transport: StreamableHTTPServerTransport
  server: McpServer
  identity: McpIdentity
}

export interface StartMcpServerOptions {
  /** Bind address; only for tests. Production always stays on loopback. */
  host?: string
  /** Fixed port; 0 (default) lets the OS choose a free one. */
  port?: number
}

/**
 * Start the HTTP listener and return the handle the app registers workspaces
 * on. Not a module singleton on purpose — tests start and close their own.
 */
export async function startMcpServer(options: StartMcpServerOptions = {}): Promise<McpServerHandle> {
  const host = options.host ?? MCP_BIND_HOST
  const workspaces = new Map<string, WorkspaceRuntime>()
  const sessions = new Map<string, SessionRecord>()

  const httpServer: Server = createServer((req, res) => {
    void handleRequest(req, res).catch((error) => {
      if (!res.headersSent) res.writeHead(500).end()
      else res.end()
      console.error('[vertragus-mcp] request failed', error)
    })
  })

  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // Refused before anything else — identity resolution must not even run
    // for a request that reached us through a rebound hostname.
    if (!isAllowedHostHeader(req.headers.host, host) || !isAllowedOrigin(req.headers.origin, host)) {
      res.writeHead(403).end()
      return
    }
    const url = new URL(req.url ?? '/', `http://${host}`)
    if (url.pathname !== MCP_PATH) {
      res.writeHead(404).end()
      return
    }

    const identity = resolveIdentity(url.searchParams, (id) => workspaces.get(id)?.ctx)
    if (!identity) {
      res.writeHead(401).end()
      return
    }
    const runtime = workspaces.get(identity.workspaceId)
    if (!runtime) {
      res.writeHead(401).end()
      return
    }

    const sessionId = req.headers['mcp-session-id'] as string | undefined
    const existing = sessionId ? sessions.get(sessionId) : undefined
    // A session belongs to the identity that opened it; a leaked session id
    // must not become a second door into another agent's tools.
    if (existing && !sameIdentity(existing.identity, identity)) {
      res.writeHead(401).end()
      return
    }

    if (req.method === 'POST') {
      const body = await readBody(req)
      let record = existing

      if (!record && isInitializeRequest(body)) {
        const server = buildServerFor(identity, runtime)
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (sid) => {
            sessions.set(sid, { transport, server, identity })
          }
        })
        transport.onclose = (): void => {
          if (transport.sessionId) sessions.delete(transport.sessionId)
        }
        await server.connect(transport)
        record = { transport, server, identity }
      }

      if (!record) {
        res.writeHead(400, { 'Content-Type': 'application/json' }).end(
          JSON.stringify({
            jsonrpc: '2.0',
            error: { code: -32000, message: 'No valid MCP session' },
            id: null
          })
        )
        return
      }

      await record.transport.handleRequest(req, res, body)
      return
    }

    if (req.method === 'GET' || req.method === 'DELETE') {
      if (!existing) {
        res.writeHead(400).end()
        return
      }
      await existing.transport.handleRequest(req, res)
      return
    }

    res.writeHead(405).end()
  }

  const port = await new Promise<number>((resolve, reject) => {
    httpServer.once('error', reject)
    httpServer.listen(options.port ?? 0, host, () => {
      const address = httpServer.address()
      resolve(typeof address === 'object' && address ? address.port : 0)
    })
  })

  function requireWorkspace(workspaceId: string): WorkspaceRuntime {
    const runtime = workspaces.get(workspaceId)
    if (!runtime) throw new Error(`Unknown MCP workspace: ${workspaceId}`)
    return runtime
  }

  function closeSessionsOf(workspaceId: string): void {
    for (const [sid, record] of [...sessions.entries()]) {
      if (record.identity.workspaceId !== workspaceId) continue
      sessions.delete(sid)
      void record.transport.close()
    }
  }

  function registerWorkspace(ctx: WorkspaceMcpContext): RegisteredWorkspace {
    if (workspaces.has(ctx.workspaceId)) {
      throw new Error(`MCP workspace already registered: ${ctx.workspaceId}`)
    }
    const runtime: WorkspaceRuntime = { ctx, questions: new PendingQuestions() }
    workspaces.set(ctx.workspaceId, runtime)
    return {
      runtime,
      orchestratorUrl: buildOrchestratorUrl(port, ctx.workspaceId, ctx.orchToken, host),
      subagentUrl: (agentId: string) =>
        buildSubagentUrl(port, ctx.workspaceId, agentId, ctx.subToken, host)
    }
  }

  function unregisterWorkspace(workspaceId: string): void {
    const runtime = workspaces.get(workspaceId)
    if (!runtime) return
    workspaces.delete(workspaceId)
    closeSessionsOf(workspaceId)
    runtime.questions.clear()
    runtime.ctx.events.close()
  }

  return {
    port,
    registerWorkspace,
    unregisterWorkspace,

    orchestratorUrl(workspaceId: string): string {
      const runtime = requireWorkspace(workspaceId)
      return buildOrchestratorUrl(port, workspaceId, runtime.ctx.orchToken, host)
    },

    subagentUrl(workspaceId: string, agentId: string): string {
      const runtime = requireWorkspace(workspaceId)
      return buildSubagentUrl(port, workspaceId, agentId, runtime.ctx.subToken, host)
    },

    pendingQuestion(workspaceId: string, agentId: string): string | undefined {
      return workspaces.get(workspaceId)?.questions.openForAgent(agentId)?.question
    },

    workspaceTask(workspaceId: string): string | undefined {
      return workspaces.get(workspaceId)?.latestTask
    },

    async close(): Promise<void> {
      for (const workspaceId of [...workspaces.keys()]) unregisterWorkspace(workspaceId)
      for (const record of [...sessions.values()]) {
        await record.transport.close().catch(() => undefined)
      }
      sessions.clear()
      await new Promise<void>((resolve) => httpServer.close(() => resolve()))
    }
  }
}
