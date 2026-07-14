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
import { orchestratorEngine, type OrchestratorEngine } from '@main/orchestrator/Engine'
import type { OrchestratorActivityPhase } from '@shared/orchestrator'
import { workspaceSessions } from '@main/orchestrator/WorkspaceSessionRegistry'
import { setMcpHandle, type McpServerHandle } from '@main/orchestrator/mcpHandle'

const ORCHESTRATOR_TOOLS = [
  'mcp__orca__set_goal',
  'mcp__orca__report_activity',
  'mcp__orca__list_subagents',
  'mcp__orca__dispatch_subagent',
  'mcp__orca__dispatch_batch',
  'mcp__orca__get_task_status',
  'mcp__orca__list_tasks',
  'mcp__orca__get_plan_status',
  'mcp__orca__cancel_plan',
  'mcp__orca__open_subwindow',
  'mcp__orca__execute_plan',
  'mcp__orca__record_retro',
  'mcp__orca__run_benchmark',
  'mcp__orca__get_benchmark_status',
  'mcp__orca__record_benchmark'
]

const AGENT_PROVIDERS = ['claude', 'codex', 'cursor', 'copilot', 'ollama'] as const

const ACTIVITY_PHASES = [
  'idle', 'planning', 'awaiting-review', 'delegating', 'monitoring',
  'reviewing', 'integrating', 'summarizing', 'completed', 'blocked'
] as const

type ToolText = { content: Array<{ type: 'text'; text: string }> }
function text(s: string): ToolText {
  return { content: [{ type: 'text', text: s }] }
}

function buildMcpServer(engine: OrchestratorEngine = orchestratorEngine): McpServer {
  const server = new McpServer(
    { name: 'orca-strator', version: '0.1.0' },
    {
      instructions: [
        'You are the Orca-Strator orchestrator. Plan and delegate instead of editing code yourself.',
        'For every new goal call set_goal first, report_activity for planning, then list_subagents and execute_plan.',
        'Use exactly the returned role values and choose only the roles the plan needs.',
        'Keep report_activity current so the user can see what you are doing, what workers are doing, and what happens next.',
        'Poll each plan to a terminal result, evaluate it against the goal, and submit focused follow-up plans when needed.',
        'After every terminal plan run call record_retro with concise per-model learnings (strengths/weaknesses); they feed back into list_subagents as learnedStrengths/learnedWeaknesses.',
        'Stop only when the goal is verified or a concrete dead end requires user input or an external change.',
        'Poll task status at meaningful transitions. Identify a worker only by the exact agentName returned by get_task_status or list_tasks.',
        'If agentName is absent, use taskId and role until a later poll returns it; never infer or invent a worker name.',
        'Report each worker task, phase, current action, and blocker.',
        'Give every subagent a complete standalone prompt and summarize their results for the user.'
      ].join(' ')
    }
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
      engine.setGoal(title)
      return text(`Ziel gesetzt: ${title}`)
    }
  )

  register(
    'report_activity',
    'Aktualisiere den sichtbaren Lagebericht des Orchestrators. Melde eigene aktuelle Arbeit, ' +
      'konkrete Details und den nächsten Schritt bei jeder wichtigen Phase oder Statusänderung.',
    {
      phase: z.enum(ACTIVITY_PHASES).describe('Aktuelle Orchestrator-Phase'),
      summary: z.string().min(1).max(280).describe('Was du als Orchestrator gerade konkret machst'),
      details: z.array(z.string().min(1).max(220)).max(4).optional()
        .describe('Bis zu vier konkrete Prüf-, Delegations- oder Koordinationsschritte'),
      nextStep: z.string().min(1).max(220).optional().describe('Dein unmittelbar nächster Schritt')
    },
    async (args) => {
      const activity = engine.reportActivity({
        phase: String(args.phase ?? 'idle') as OrchestratorActivityPhase,
        summary: String(args.summary ?? ''),
        details: Array.isArray(args.details) ? args.details.map(String) : [],
        nextStep: args.nextStep ? String(args.nextStep) : undefined
      })
      return text(JSON.stringify(activity, null, 2))
    }
  )

  register(
    'list_subagents',
    'Liste den verfügbaren Fähigkeiten-Pool mit Rollen, Provider, Modell, Kapazität, Stärken und Schwächen. ' +
      'learnedStrengths/learnedWeaknesses sind aus Retros und Benchmarks früherer Läufe gelerntes Modellwissen — nutze es bei der Rollenwahl. ' +
      'Die Rollen sind nicht zwingend bereits gestartet; ein Plan startet nur die ausgewählten Agents.',
    {},
    async () => text(JSON.stringify(await engine.listSubagentsWithHealth(), null, 2))
  )

  register(
    'dispatch_subagent',
    'Starte eine Teilaufgabe asynchron. Die Antwort enthält sofort taskId und Status; ' +
      'Ergebnis und Heartbeat werden danach mit get_task_status abgefragt.',
    {
      role: z.string().describe('Rolle/Slot aus list_subagents (z.B. "worker", "backend")'),
      prompt: z.string().describe('Vollständige, eigenständige Aufgabenbeschreibung für den Subagenten'),
      title: z.string().optional().describe('Optionaler Kurztitel für die Aufgaben-Ansicht')
    },
    async (args) => {
      const task = engine.dispatchAsync(
        String(args.role ?? 'worker'),
        String(args.prompt ?? ''),
        args.title ? String(args.title) : undefined
      )
      return text(JSON.stringify(task, null, 2))
    }
  )

  register(
    'dispatch_batch',
    'Starte mehrere Teilaufgaben parallel und gib sofort ihre taskIds zurück. ' +
      'Ergebnisse werden mit get_task_status oder list_tasks abgefragt.',
    {
      tasks: z
        .array(
          z.object({
            role: z.string().describe('Rolle aus list_subagents'),
            prompt: z.string().describe('Vollständige, eigenständige Aufgabe'),
            title: z.string().optional()
          })
        )
        .describe('Liste der parallel zu startenden Teilaufgaben')
    },
    async (args) => {
      const tasks = (args.tasks as Array<{ role: string; prompt: string; title?: string }>) ?? []
      return text(JSON.stringify(engine.dispatchBatchAsync(tasks), null, 2))
    }
  )

  register(
    'get_task_status',
    'Liefere Titel, Rolle, Subagent-Name, Status, Heartbeat, Phase, aktuelle Aktion und finales Ergebnis einer asynchronen Aufgabe.',
    { taskId: z.string().describe('taskId aus dispatch_subagent oder dispatch_batch') },
    async (args) => {
      const result = engine.getTaskStatus(String(args.taskId ?? ''))
      return text(JSON.stringify(result ?? { error: 'Task nicht gefunden.' }, null, 2))
    }
  )

  register(
    'list_tasks',
    'Liste alle Tasks mit Titel, Rolle, Subagent-Name, aktuellem Status, Phase, Aktion, Heartbeat und Ergebnis.',
    {},
    async () => text(JSON.stringify(engine.listTaskStatuses(), null, 2))
  )

  register(
    'get_plan_status',
    'Liefere den wahrheitsgetreuen Gesamtstatus sowie jeden Knoten mit Phase, Heartbeat, ' +
      'letzter Aktion, Findings und Engine-/Workspace-Identität.',
    { runId: z.string().describe('runId aus execute_plan') },
    async (args) => {
      const result = engine.getPlanRunStatus(String(args.runId ?? ''))
      return text(JSON.stringify(result ?? { error: 'Planlauf nicht gefunden.' }, null, 2))
    }
  )

  register(
    'cancel_plan',
    'Stoppe einen Planlauf oder verwirf ohne runId den Plan, der gerade auf Review wartet. ' +
      'Fehler werden als strukturierte Antwort geliefert und lösen keine Tool-Exception aus.',
    {
      runId: z.string().min(1).optional()
        .describe('Optional: runId aus execute_plan; ohne runId wird der wartende Review-Plan verworfen')
    },
    async (args) => {
      const result = await engine.cancelPlan(args.runId ? String(args.runId) : undefined)
      return text(JSON.stringify(result, null, 2))
    }
  )

  register(
    'execute_plan',
    'Validiere und starte einen kompletten Auto-Subagent-Plan asynchron als DAG. Die Antwort ' +
      'enthält sofort runId, usedFallback, rejected, validationIssues und planTaskIds. ' +
      'Ein rejected-Plan endet ohne Task-Start; laufende Ergebnisse werden mit get_plan_status abgefragt. ' +
      'Bewerte danach das Gesamtziel und reiche bei Bedarf einen fokussierten Folgeplan ein.',
    {
      plan: z.object({
        version: z.literal(1).optional(),
        goal: z.string(),
        maxParallel: z.number(),
        tasks: z.array(
          z.object({
            id: z.string(),
            title: z.string(),
            role: z.string(),
            prompt: z.string(),
            dependsOn: z.array(z.string()).optional(),
            advisoryDependsOn: z.array(z.string()).optional(),
            conflictKeys: z.array(z.string()).optional(),
            criticality: z.enum(['required', 'advisory']).optional(),
            ownership: z.enum(['feature', 'integrator']).optional(),
            expectedFiles: z.array(z.string()).optional()
          })
        )
      })
    },
    async (args) => {
      const rawPlan = args.plan as Record<string, unknown>
      const rawTasks = Array.isArray(rawPlan?.tasks)
        ? rawPlan.tasks.map((raw) => {
            const task = raw as Record<string, unknown>
            return {
              ...task,
              dependsOn: task.dependsOn ?? [],
              advisoryDependsOn: task.advisoryDependsOn ?? [],
              conflictKeys: task.conflictKeys ?? [],
              criticality: task.criticality ?? 'required',
              ownership: task.ownership ?? 'feature',
              expectedFiles: task.expectedFiles ?? []
            }
          })
        : rawPlan?.tasks
      const result = engine.executePlanAsync({
        ...rawPlan,
        version: 1,
        tasks: rawTasks
      })
      return text(JSON.stringify(result, null, 2))
    }
  )

  register(
    'record_retro',
    'Speichere nach einem terminalen Lauf eine kurze Retrospektive mit Modell-Erkenntnissen, ' +
      'z.B. "sehr stark bei UI-Aufgaben" oder "Code-Review besonders präzise". Die Erkenntnisse ' +
      'werden dauerhaft gespeichert und fließen als learnedStrengths/learnedWeaknesses in list_subagents zurück.',
    {
      summary: z.string().min(1).max(500).describe('Kurzes Fazit des Laufs in ein bis zwei Sätzen'),
      learnings: z
        .array(
          z.object({
            provider: z.enum(AGENT_PROVIDERS).describe('Provider des bewerteten Modells'),
            model: z.string().min(1).describe('Exakter Modellname aus list_subagents/get_task_status'),
            role: z.string().optional().describe('Rollen-Kontext der Beobachtung, z.B. "frontend"'),
            kind: z.enum(['strength', 'weakness']).describe('Stärke oder Schwäche'),
            insight: z.string().min(1).max(200).describe('Kurze Erkenntnis, z.B. "sehr stark bei UI-Aufgaben"'),
            evidence: z.string().max(300).optional().describe('Konkreter Beleg aus diesem Lauf')
          })
        )
        .max(20)
        .describe('Konkrete Modell-Erkenntnisse aus diesem Lauf')
    },
    async (args) => {
      const result = engine.recordOrchestratorRetro({
        summary: String(args.summary ?? ''),
        learnings: Array.isArray(args.learnings)
          ? (args.learnings as Array<{
              provider: (typeof AGENT_PROVIDERS)[number]
              model: string
              role?: string
              kind: 'strength' | 'weakness'
              insight: string
              evidence?: string
            }>)
          : []
      })
      return text(JSON.stringify(result, null, 2))
    }
  )

  register(
    'run_benchmark',
    'Starte einen Auto-Benchmark: DIESELBE Aufgabe läuft parallel auf jedem verfügbaren Slot ' +
      '(isolierte Worktrees). Die Antwort enthält sofort benchmarkId und taskIds; ' +
      'Status und Ergebnisse werden mit get_benchmark_status und get_task_status abgefragt.',
    {
      prompt: z.string().min(1).describe('Vollständige, eigenständige Aufgabe, identisch für alle Slots'),
      title: z.string().optional().describe('Kurztitel des Benchmarks für die Aufgaben-Ansicht')
    },
    async (args) => {
      const result = engine.runBenchmarkAsync(
        String(args.prompt ?? ''),
        args.title ? String(args.title) : undefined
      )
      return text(JSON.stringify(result, null, 2))
    }
  )

  register(
    'get_benchmark_status',
    'Liefere den Stand eines Benchmarks: je Teilnehmer Status, Phase, letzte Aktion, Dauer, ' +
      'Tokenverbrauch und finales Ergebnis. status=completed sobald alle Läufe terminal sind.',
    { benchmarkId: z.string().describe('benchmarkId aus run_benchmark') },
    async (args) => {
      const result = engine.getBenchmarkStatus(String(args.benchmarkId ?? ''))
      return text(JSON.stringify(result ?? { error: 'Benchmark nicht gefunden.' }, null, 2))
    }
  )

  register(
    'record_benchmark',
    'Bewerte einen abgeschlossenen Benchmark: Score 0-10, Verdict und Stärken/Schwächen je Teilnehmer. ' +
      'Die Bewertung wird dauerhaft gespeichert und als Modellwissen für künftige Rollenwahl genutzt.',
    {
      benchmarkId: z.string().describe('benchmarkId aus run_benchmark'),
      task: z.string().min(1).describe('Die gemeinsame Aufgabe, die alle Teilnehmer ausgeführt haben'),
      summary: z.string().min(1).max(800).describe('Gesamtfazit inkl. Sieger und Begründung'),
      rankings: z
        .array(
          z.object({
            role: z.string().describe('Rolle des Teilnehmers aus run_benchmark'),
            provider: z.enum(AGENT_PROVIDERS).optional(),
            model: z.string().optional(),
            score: z.number().min(0).max(10).describe('Faire Bewertung 0-10'),
            verdict: z.string().max(300).describe('Kurzbegründung der Bewertung'),
            strengths: z.array(z.string().min(1).max(200)).max(8).optional(),
            weaknesses: z.array(z.string().min(1).max(200)).max(8).optional()
          })
        )
        .min(1)
        .max(16)
        .describe('Bewertung je Teilnehmer')
    },
    async (args) => {
      const result = engine.recordBenchmark({
        benchmarkId: String(args.benchmarkId ?? ''),
        task: String(args.task ?? ''),
        summary: String(args.summary ?? ''),
        rankings: Array.isArray(args.rankings)
          ? (args.rankings as Parameters<typeof engine.recordBenchmark>[0]['rankings'])
          : []
      })
      return text(JSON.stringify(result, null, 2))
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
      const id = await engine.openSubwindow(
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
  const authToken = randomUUID()

  const httpServer: Server = createServer((req, res) => {
    void handleRequest(req, res).catch((err) => {
      if (!res.headersSent) res.writeHead(500).end()
      console.error('[OrcaMcp] request error', err)
    })
  })

  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (url.pathname !== '/mcp') {
      res.writeHead(404).end()
      return
    }
    if (url.searchParams.get('token') !== authToken) {
      res.writeHead(401).end()
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
        const workspaceSessionId = url.searchParams.get('workspaceSession')
        const engine = workspaceSessionId
          ? workspaceSessions.getById(workspaceSessionId)?.engine
          : orchestratorEngine
        if (!engine) throw new Error('Workspace-Session ist nicht mehr aktiv.')
        const requestedEngineId = url.searchParams.get('engineId')
        if (requestedEngineId && requestedEngineId !== engine.engineId) {
          throw new Error('Orchestrator-Verbindung verweist auf eine veraltete Engine-Instanz.')
        }
        await buildMcpServer(engine).connect(transport)
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
    url: `http://127.0.0.1:${port}/mcp?token=${encodeURIComponent(authToken)}`,
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
