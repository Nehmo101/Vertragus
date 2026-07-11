/**
 * OrcaMcpServer — a Streamable-HTTP MCP server (localhost only) that exposes
 * the orchestration tools to the orchestrator agent. Both the server and the
 * agent processes live in the Electron main process, so tool calls route
 * directly into the OrchestratorEngine (no extra IPC hop).
 *
 * Tools:
 *   set_goal(title)                     — report the current high-level goal
 *   list_subagents()                    — available subagent slots
 *   dispatch_subagent(role, prompt, …)  — run a subagent, return its result
 *   open_subwindow(role, prompt?)       — persistent interactive subagent window
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js'
import { orchestratorEngine } from '@main/orchestrator/Engine'
import { setMcpHandle, type McpServerHandle } from '@main/orchestrator/mcpHandle'

const ORCHESTRATOR_TOOLS = [
  'mcp__orca__set_goal',
  'mcp__orca__list_subagents',
  'mcp__orca__dispatch_subagent',
  'mcp__orca__open_subwindow'
]

type ToolText = { content: Array<{ type: 'text'; text: string }> }
function text(s: string): ToolText {
  return { content: [{ type: 'text', text: s }] }
}

function buildMcpServer(): McpServer {
  const server = new McpServer(
    { name: 'orca-strator', version: '0.1.0' },
    { instructions: 'Orchestration tools for delegating work to Orca-Strator subagents.' }
  )

  // server.tool's generic inference over zod shapes is extremely deep and trips
  // TS2589; cast to a loose signature so registration stays simple and typed at
  // the boundary (handler args are validated by the shape at runtime).
  const toolFn = server.tool.bind(server) as (
    name: string,
    description: string,
    shape: z.ZodRawShape,
    handler: (args: Record<string, unknown>) => Promise<ToolText>
  ) => void
  const register = (
    name: string,
    description: string,
    shape: z.ZodRawShape,
    handler: (args: Record<string, unknown>) => Promise<ToolText>
  ): void => {
    toolFn(name, description, shape, handler)
  }

  register(
    'set_goal',
    'Melde das aktuelle Gesamtziel, das du orchestrierst (kurzer Titel). Rufe dies zuerst auf.',
    { title: z.string().describe('Kurzer Titel des Ziels, z.B. "Checkout-Flow v2"') },
    async (args) => {
      const title = String(args.title ?? '')
      orchestratorEngine.setGoal(title)
      return text(`Ziel gesetzt: ${title}`)
    }
  )

  register(
    'list_subagents',
    'Liste die verfügbaren Subagent-Rollen (Provider, Modell, Kapazität), an die du delegieren kannst.',
    {},
    async () => text(JSON.stringify(orchestratorEngine.listSubagents(), null, 2))
  )

  register(
    'dispatch_subagent',
    'Delegiere eine Teilaufgabe an einen Subagenten und warte auf dessen Ergebnis. ' +
      'Der Subagent läuft real (eigenes Pane) und gibt seine finale Antwort zurück.',
    {
      role: z.string().describe('Rolle/Slot aus list_subagents (z.B. "worker", "backend")'),
      prompt: z.string().describe('Vollständige, eigenständige Aufgabenbeschreibung für den Subagenten'),
      title: z.string().optional().describe('Optionaler Kurztitel für die Aufgaben-Ansicht')
    },
    async (args) => {
      const result = await orchestratorEngine.dispatch(
        String(args.role ?? 'worker'),
        String(args.prompt ?? ''),
        args.title ? String(args.title) : undefined
      )
      return text(result)
    }
  )

  register(
    'open_subwindow',
    'Öffne einen persistenten, interaktiven Subagenten in einem eigenen Fenster ' +
      '(für längere, dialogische Arbeit statt einer einmaligen Aufgabe).',
    {
      role: z.string().describe('Rolle/Slot aus list_subagents'),
      prompt: z.string().optional().describe('Optionaler Start-Prompt')
    },
    async (args) => {
      const id = await orchestratorEngine.openSubwindow(
        String(args.role ?? 'worker'),
        args.prompt ? String(args.prompt) : undefined
      )
      return text(`Subagent-Fenster geöffnet: ${id}`)
    }
  )

  return server
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  if (chunks.length === 0) return undefined
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    return undefined
  }
}

let started: McpServerHandle | null = null

/** Start (once) the MCP HTTP server and return its connection info. */
export async function startMcpServer(): Promise<McpServerHandle> {
  if (started) return started

  // sessionId -> transport (stateful; one session per orchestrator client)
  const transports = new Map<string, StreamableHTTPServerTransport>()

  const httpServer: Server = createServer((req, res) => {
    void handleRequest(req, res).catch((err) => {
      if (!res.headersSent) res.writeHead(500).end()
      console.error('[OrcaMcp] request error', err)
    })
  })

  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = req.url ?? ''
    if (!url.startsWith('/mcp')) {
      res.writeHead(404).end()
      return
    }
    const sessionId = req.headers['mcp-session-id'] as string | undefined

    if (req.method === 'POST') {
      const body = await readBody(req)
      let transport = sessionId ? transports.get(sessionId) : undefined

      if (!transport && isInitializeRequest(body)) {
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (sid): void => {
            transports.set(sid, transport!)
          }
        })
        transport.onclose = (): void => {
          if (transport!.sessionId) transports.delete(transport!.sessionId)
        }
        await buildMcpServer().connect(transport)
      }
      if (!transport) {
        res.writeHead(400, { 'Content-Type': 'application/json' }).end(
          JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'No valid session' }, id: null })
        )
        return
      }
      await transport.handleRequest(req, res, body)
      return
    }

    // GET (SSE stream) / DELETE (end session)
    if (req.method === 'GET' || req.method === 'DELETE') {
      const transport = sessionId ? transports.get(sessionId) : undefined
      if (!transport) {
        res.writeHead(400).end()
        return
      }
      await transport.handleRequest(req, res)
      return
    }

    res.writeHead(405).end()
  }

  const port = await new Promise<number>((resolve) => {
    httpServer.listen(0, '127.0.0.1', () => {
      const addr = httpServer.address()
      resolve(typeof addr === 'object' && addr ? addr.port : 0)
    })
  })

  started = {
    url: `http://127.0.0.1:${port}/mcp`,
    allowedTools: ORCHESTRATOR_TOOLS,
    close: () =>
      new Promise<void>((resolve) => {
        for (const t of transports.values()) void t.close()
        httpServer.close(() => resolve())
        setMcpHandle(null)
      })
  }
  setMcpHandle(started)
  return started
}
