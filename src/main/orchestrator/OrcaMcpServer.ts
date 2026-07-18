/**
 * OrcaMcpServer — a Streamable-HTTP MCP server (localhost only) that exposes
 * the orchestration tools to the orchestrator agent. Both the server and the
 * agent processes live in the Electron main process, so tool calls route
 * directly into the OrchestratorEngine (no extra IPC hop).
 *
 * Orchestrator tools:
 *   get_handoff_context(...)            — receive correlated handoff knowledge
 *   acknowledge_handoff(...)            — confirm knowledge before source shutdown
 *   set_goal(title)                     — report the current high-level goal
 *   list_subagents()                    — available subagent slots
 *   dispatch_subagent(role, prompt, …)  — run a subagent, return its result
 *   open_subwindow(role, prompt?)       — persistent interactive subagent window
 *
 * Subagent sessions (separate token, `subagentTask` query param) get a
 * deliberately small surface: report_progress, post_finding, list_findings.
 * The findings board is how parallel workers coordinate interfaces and
 * decisions with each other without waiting for terminal task results.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js'
import { orchestratorEngine, type OrchestratorEngine } from '@main/orchestrator/Engine'
import type { OrchestratorActivityPhase, SubagentFindingKind } from '@shared/orchestrator'
import { agentManager } from '@main/agents/AgentManager'
import type { HandoffClientIdentity } from '@main/agents/handoffHandshake'
import { workspaceSessions } from '@main/orchestrator/WorkspaceSessionRegistry'
import {
  setMcpHandle,
  SUBAGENT_MCP_SERVER_NAME,
  type McpServerHandle
} from '@main/orchestrator/mcpHandle'
import { removeModelLearnings } from '@main/orchestrator/retroStore'

const ORCHESTRATOR_TOOLS = [
  'mcp__orca__get_handoff_context',
  'mcp__orca__acknowledge_handoff',
  'mcp__orca__set_goal',
  'mcp__orca__report_activity',
  'mcp__orca__list_subagents',
  'mcp__orca__dispatch_subagent',
  'mcp__orca__dispatch_batch',
  'mcp__orca__get_task_status',
  'mcp__orca__list_tasks',
  'mcp__orca__await_task',
  'mcp__orca__await_any',
  'mcp__orca__list_findings',
  'mcp__orca__list_multiagent_runs',
  'mcp__orca__review_multiagent',
  'mcp__orca__list_subagent_requests',
  'mcp__orca__respond_subagent',
  'mcp__orca__get_plan_status',
  'mcp__orca__await_plan',
  'mcp__orca__cancel_plan',
  'mcp__orca__open_subwindow',
  'mcp__orca__execute_plan',
  'mcp__orca__get_retro_draft',
  'mcp__orca__record_retro',
  'mcp__orca__revoke_learning',
  'mcp__orca__run_benchmark',
  'mcp__orca__get_benchmark_status',
  'mcp__orca__record_benchmark'
]

const FINDING_KINDS = ['interface', 'decision', 'blocker', 'insight'] as const
const SUBAGENT_PROGRESS_PHASES = ['working', 'testing', 'committing'] as const
const MAX_REQUEST_BODY_BYTES = 2 * 1024 * 1024

/** Optional long-poll window for the blocking await_* tools (engine clamps it too). */
const AWAIT_TIMEOUT_SHAPE = z.number().int().min(1_000).max(55_000).optional()
  .describe('Optionales serverseitiges Wartefenster in ms (Standard 25000, min 1000, max 55000).')

const AGENT_PROVIDERS = ['claude', 'kimi', 'codex', 'cursor', 'copilot', 'ollama'] as const

const ACTIVITY_PHASES = [
  'idle', 'planning', 'awaiting-review', 'delegating', 'monitoring',
  'reviewing', 'integrating', 'summarizing', 'completed', 'blocked'
] as const

type ToolText = { content: Array<{ type: 'text'; text: string }> }
function text(s: string): ToolText {
  return { content: [{ type: 'text', text: s }] }
}

function buildMcpServer(
  engine: OrchestratorEngine = orchestratorEngine,
  clientIdentity?: HandoffClientIdentity
): McpServer {
  const server = new McpServer(
    { name: 'vertragus', version: '0.1.0' },
    {
      instructions: [
        'You are the Vertragus orchestrator. Plan and delegate instead of editing code yourself.',
        'For every new goal call set_goal first, report_activity for planning, then list_subagents and execute_plan.',
        'Use exactly the returned role values and choose only the roles the plan needs.',
        'Keep report_activity current so the user can see what you are doing, what workers are doing, and what happens next.',
        'Use await_plan(runId) to block until a plan reaches a terminal result instead of repeatedly polling; re-call await_plan whenever it returns stillRunning. Then evaluate it against the goal and submit focused follow-up plans when needed.',
        'After every terminal plan run call get_retro_draft, fill only the qualitative insight/evidence fields, then pass the completed templates to record_retro; they feed back into list_subagents as learnedStrengths/learnedWeaknesses.',
        'Stop only when the goal is verified or a concrete dead end requires user input or an external change.',
        'To wait for worker results use await_task(taskId) or await_any(taskIds) to block instead of polling; call get_task_status/list_tasks only for a one-off snapshot (e.g. to read the exact agentName). Identify a worker only by the exact agentName returned by get_task_status or list_tasks.',
        'If agentName is absent, use taskId and role until a later poll returns it; never infer or invent a worker name.',
        'Report each worker task, phase, current action, and blocker.',
        'Check list_subagent_requests regularly and answer pending worker questions with respond_subagent; use stop only when that worker must not continue.',
        'After dispatching in Multiagent mode, inspect list_multiagent_runs. For every awaiting-review group compare task results, diffs, tests and findings, then call review_multiagent with accept, revise or reject. Accept exactly one candidate; never integrate competing candidates together.',
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
    'get_handoff_context',
    'Rufe als neu gestarteter Orchestrator den exakt korrelierten Übergabekontext ab. ' +
      'Die Antwort enthält Briefing, aktuellen Engine-/Task-Zustand und den zu bestätigenden knowledgeDigest.',
    {
      handoffId: z.string().uuid().describe('handoffId aus dem Start-Prompt'),
      receiptToken: z.string().regex(/^[a-f0-9]{64}$/).describe('Einmaliger receiptToken aus dem Start-Prompt')
    },
    async (args) => {
      if (!clientIdentity) {
        return text(JSON.stringify({
          ok: false,
          code: 'wrong-target',
          message: 'Diese MCP-Verbindung ist keinem konkreten Orchestrator-Prozess zugeordnet.'
        }, null, 2))
      }
      const result = agentManager.readOrchestratorHandoffContext(
        {
          handoffId: String(args.handoffId ?? ''),
          receiptToken: String(args.receiptToken ?? '')
        },
        clientIdentity,
        {
          snapshot: engine.snapshot(),
          tasks: engine.listTaskStatuses()
        }
      )
      return text(JSON.stringify(result, null, 2))
    }
  )

  register(
    'acknowledge_handoff',
    'Bestätige erst nach vollständiger Prüfung des mit get_handoff_context gelieferten Wissensstands. ' +
      'Nur eine exakt korrelierte Bestätigung beendet den alten Orchestrator.',
    {
      handoffId: z.string().uuid().describe('handoffId des abgerufenen Kontexts'),
      receiptToken: z.string().regex(/^[a-f0-9]{64}$/).describe('Einmaliger receiptToken'),
      knowledgeDigest: z.string().regex(/^[a-f0-9]{64}$/).describe('knowledgeDigest aus get_handoff_context'),
      summary: z.string().min(8).max(500).describe('Konkrete Kurzfassung des übernommenen Arbeitsstands')
    },
    async (args) => {
      if (!clientIdentity) {
        return text(JSON.stringify({
          ok: false,
          code: 'wrong-target',
          message: 'Diese MCP-Verbindung ist keinem konkreten Orchestrator-Prozess zugeordnet.'
        }, null, 2))
      }
      const result = await agentManager.acknowledgeOrchestratorHandoff(
        {
          handoffId: String(args.handoffId ?? ''),
          receiptToken: String(args.receiptToken ?? ''),
          knowledgeDigest: String(args.knowledgeDigest ?? ''),
          summary: String(args.summary ?? '')
        },
        clientIdentity
      )
      return text(JSON.stringify(result, null, 2))
    }
  )

  register(
    'set_goal',
    'Melde das aktuelle Gesamtziel, das du orchestrierst (kurzer Titel). Rufe dies zuerst auf.',
    { title: z.string().describe('Kurzer Titel des Ziels, z.B. "Checkout-Flow v2"') },
    async (args) => {
      const title = String(args.title ?? '')
      const { retroReminder } = engine.setGoal(title)
      const lines = [`Ziel gesetzt: ${title}`]
      if (retroReminder) lines.push(`⚠ Retro offen: ${retroReminder.message}`)
      return text(lines.join('\n'))
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
    'await_task',
    'Blockiere serverseitig, bis eine Aufgabe einen Terminalstatus (success/needs-work/error/stopped) ' +
      'erreicht, statt get_task_status wiederholt zu pollen. Kehrt sofort zurück, wenn die Aufgabe schon ' +
      'terminal ist. Bei stillRunning:true (Timeout) sofort erneut aufrufen.',
    {
      taskId: z.string().describe('taskId aus dispatch_subagent oder dispatch_batch'),
      timeoutMs: AWAIT_TIMEOUT_SHAPE
    },
    async (args) =>
      text(JSON.stringify(
        await engine.awaitTask(String(args.taskId ?? ''), args.timeoutMs as number | undefined),
        null,
        2
      ))
  )

  register(
    'await_any',
    'Blockiere, bis EINE von mehreren Aufgaben terminal wird; liefert diese Aufgabe plus die noch offenen ' +
      'taskIds (pending). Ersetzt das Rundum-Pollen paralleler Worker. Bei stillRunning:true erneut mit den ' +
      'offenen taskIds aufrufen.',
    {
      taskIds: z.array(z.string()).min(1).max(64).describe('taskIds paralleler Aufgaben'),
      timeoutMs: AWAIT_TIMEOUT_SHAPE
    },
    async (args) =>
      text(JSON.stringify(
        await engine.awaitAnyTask((args.taskIds as string[]) ?? [], args.timeoutMs as number | undefined),
        null,
        2
      ))
  )

  register(
    'list_findings',
    'Liste die Einträge des gemeinsamen Findings-Boards: Schnittstellen, Entscheidungen, Blocker ' +
      'und Erkenntnisse, die Subagents während laufender Tasks live geteilt haben.',
    {},
    async () => text(JSON.stringify(engine.listTaskFindings(), null, 2))
  )

  register(
    'list_multiagent_runs',
    'Liste konkurrierende Kandidatengruppen samt Kandidaten-Task-IDs und Reviewstatus. ' +
      'Bei awaiting-review müssen Ergebnisse, Diffs, Tests und Findings bewertet werden.',
    {},
    async () => text(JSON.stringify(engine.listMultiAgentRuns(), null, 2))
  )

  register(
    'review_multiagent',
    'Triff die verbindliche Reviewentscheidung für eine Multiagent-Gruppe: genau einen Kandidaten ' +
      'übernehmen, einen Kandidaten mit konkretem Feedback überarbeiten lassen oder alle verwerfen.',
    {
      runId: z.string().min(1),
      action: z.enum(['accept', 'revise', 'reject']),
      candidateTaskId: z.string().min(1).optional(),
      feedback: z.string().min(8).max(2_000).describe('Konkrete Code-Review-Begründung oder Überarbeitungsanweisung')
    },
    async (args) => text(JSON.stringify(await engine.reviewMultiAgentRun({
      runId: String(args.runId ?? ''),
      action: String(args.action ?? 'reject') as 'accept' | 'revise' | 'reject',
      candidateTaskId: args.candidateTaskId ? String(args.candidateTaskId) : undefined,
      feedback: String(args.feedback ?? '')
    }), null, 2))
  )

  register(
    'list_subagent_requests',
    'Liste direkte Rückfragen und Unterstützungsanfragen laufender Subagents. Standardmäßig nur offene Anfragen.',
    { pendingOnly: z.boolean().optional() },
    async (args) => text(JSON.stringify(engine.listSubagentSupportRequests(args.pendingOnly !== false), null, 2))
  )

  register(
    'respond_subagent',
    'Antworte einer Subagent-Rückfrage konkret. continue liefert die Antwort an den wartenden Worker; ' +
      'stop beendet den Worker, wenn er an diesem Task nicht weiterarbeiten darf.',
    {
      requestId: z.string().min(1),
      response: z.string().min(1).max(2_000),
      action: z.enum(['continue', 'stop']).default('continue')
    },
    async (args) => text(JSON.stringify(await engine.respondSubagentSupport(
      String(args.requestId ?? ''),
      String(args.response ?? ''),
      String(args.action ?? 'continue') as 'continue' | 'stop'
    ), null, 2))
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
    'await_plan',
    'Blockiere, bis ein Planlauf terminal ist (success/needs-work/error/stopped), statt get_plan_status ' +
      'wiederholt zu pollen. Kehrt sofort zurück, wenn der Lauf schon terminal ist. Wartet ein Plan auf ' +
      'Freigabe, bleibt stillRunning:true, bis der Nutzer den Plan freigibt. Bei stillRunning:true erneut aufrufen. ' +
      'Bei einem terminalen Lauf ohne erfasstes qualitatives Retro enthält die Antwort retroPending:true und ' +
      'ein ausfüllfertiges retroDraft — fülle je Modell strength UND weakness und rufe record_retro auf.',
    {
      runId: z.string().describe('runId aus execute_plan'),
      timeoutMs: AWAIT_TIMEOUT_SHAPE
    },
    async (args) =>
      text(JSON.stringify(
        await engine.awaitPlan(String(args.runId ?? ''), args.timeoutMs as number | undefined),
        null,
        2
      ))
  )

  register(
    'await_plan_approval',
    'Blockiere, bis die Panel-Freigabe eines Planlaufs entschieden ist (reviewState approved/rejected), ' +
      'statt list_tasks/get_plan_status zu pollen. Kehrt sofort zurück, wenn keine Freigabe nötig ist ' +
      '(reviewState not-required) oder schon entschieden wurde. Bei stillRunning:true erneut aufrufen.',
    {
      runId: z.string().describe('runId aus execute_plan'),
      timeoutMs: AWAIT_TIMEOUT_SHAPE
    },
    async (args) =>
      text(JSON.stringify(
        await engine.awaitPlanApproval(String(args.runId ?? ''), args.timeoutMs as number | undefined),
        null,
        2
      ))
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
      'Reparierbare Ownership-Probleme werden automatisch korrigiert (repaired_ownership in validationIssues). ' +
      'Ein rejected-Plan startet keine Tasks direkt: sein konservativer Ersatz-Task wartet am Review-Gate auf Freigabe — ' +
      'prüfe validationIssues, reiche einen korrigierten Plan ein oder lass den Ersatz-Task freigeben. ' +
      'Laufende Ergebnisse werden mit get_plan_status abgefragt. ' +
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
    'get_retro_draft',
    'Erzeuge nach einem terminalen Planlauf ein Fakten-Gerüst für record_retro. ' +
      'Modellnamen, Task-Bilanz, Fehlerarten, Gate-Findings, Dauer-Rang und Nutzung sind vorausgefüllt; ' +
      'ergänze danach nur insight/evidence in den Learning-Templates.',
    {
      planId: z.string().trim().min(1).optional()
        .describe('Optionale Plan-ID; Standard ist der letzte terminale Planlauf')
    },
    async (args) => {
      const result = engine.buildRetroDraft(
        typeof args.planId === 'string' ? args.planId : undefined
      )
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
    'revoke_learning',
    'Lösche nachweislich falsches Modellwissen. Provider und Modell müssen exakt passen; ' +
      'insightContains wird als case-insensitiver Teilstring auf den Insight angewendet.',
    {
      provider: z.enum(AGENT_PROVIDERS).describe('Exakter Provider des zu löschenden Modellwissens'),
      model: z.string().min(1).describe('Exakter Modellname des zu löschenden Modellwissens'),
      insightContains: z.string().trim().min(5)
        .describe('Mindestens fünf Zeichen aus dem zu löschenden Insight')
    },
    async (args) => {
      const removed = removeModelLearnings(
        String(args.provider ?? '') as (typeof AGENT_PROVIDERS)[number],
        String(args.model ?? ''),
        String(args.insightContains ?? '')
      )
      const deleted = removed.map(({ insight, evidence }) => ({
        insight,
        evidence: evidence ?? null
      }))
      if (deleted.length === 0) {
        return text(JSON.stringify({
          message: 'Kein passendes Modell-Learning gefunden; es wurde nichts gelöscht.',
          deleted
        }, null, 2))
      }
      return text(JSON.stringify({
        message: `${deleted.length} Modell-Learning(s) gelöscht.`,
        deleted
      }, null, 2))
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

/**
 * The deliberately small MCP surface a headless worker gets: it can report its
 * own progress and exchange findings with parallel tasks, nothing else. The
 * task identity is fixed server-side from the session URL, so a worker can
 * only ever report as itself.
 */
function buildSubagentMcpServer(engine: OrchestratorEngine, taskId: string): McpServer {
  const server = new McpServer(
    { name: SUBAGENT_MCP_SERVER_NAME, version: '0.1.0' },
    {
      instructions: [
        'Du bist ein Vertragus Subagent. Über diese Tools kommunizierst du mit dem Orchestrator und parallelen Subagents.',
        'Melde wichtige Phasenwechsel und Zwischenstände knapp über report_progress.',
        'Teile Schnittstellen, Entscheidungen und Blocker, die parallele Tasks betreffen, über post_finding.',
        'Lies mit list_findings die Einträge anderer Subagents, bevor du gemeinsame Schnittstellen festlegst.',
        'Wenn dir eine Richtungsentscheidung, Freigabe oder Hilfe fehlt, stelle eine konkrete Frage mit ask_orchestrator und warte mit await_orchestrator_response auf die Antwort.'
      ].join(' ')
    }
  )
  const toolFn = server.tool.bind(server) as (
    name: string,
    description: string,
    shape: z.ZodRawShape,
    handler: (args: Record<string, unknown>) => Promise<ToolText>
  ) => void

  toolFn(
    'report_progress',
    'Melde dem Orchestrator deinen aktuellen Zwischenstand (kurzer Satz, optional Phase). ' +
      'Der Eintrag erscheint live in der Task-Ansicht und in get_task_status.',
    {
      message: z.string().min(1).max(220).describe('Was du gerade konkret tust oder erreicht hast'),
      phase: z.enum(SUBAGENT_PROGRESS_PHASES).optional().describe('Optionale Arbeitsphase')
    },
    async (args) => {
      const status = engine.reportSubagentProgress(taskId, {
        message: String(args.message ?? ''),
        phase: args.phase as (typeof SUBAGENT_PROGRESS_PHASES)[number] | undefined
      })
      return text(status ? JSON.stringify({ ok: true, taskId, lastAction: status.lastAction, phase: status.phase }) : JSON.stringify({ ok: false, error: 'Task nicht gefunden.' }))
    }
  )

  toolFn(
    'post_finding',
    'Teile eine Erkenntnis mit dem Orchestrator und parallelen Subagents: eine Schnittstelle, ' +
      'die du festgelegt hast, eine Entscheidung, einen Blocker oder eine wichtige Einsicht.',
    {
      kind: z.enum(FINDING_KINDS).describe('Art des Eintrags'),
      title: z.string().min(1).max(160).describe('Kurzer, eindeutiger Titel'),
      detail: z.string().min(1).max(2_000).describe('Konkreter Inhalt, z.B. Signaturen, Pfade, Begründung'),
      files: z.array(z.string().min(1).max(300)).max(32).optional().describe('Betroffene Dateien')
    },
    async (args) => {
      try {
        const finding = engine.postTaskFinding(taskId, {
          kind: String(args.kind ?? 'insight') as SubagentFindingKind,
          title: String(args.title ?? ''),
          detail: String(args.detail ?? ''),
          files: Array.isArray(args.files) ? args.files.map(String) : undefined
        })
        return text(JSON.stringify({ ok: true, findingId: finding.id }))
      } catch (error) {
        return text(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }))
      }
    }
  )

  toolFn(
    'list_findings',
    'Liste die für deinen Task sichtbaren Einträge des gemeinsamen Findings-Boards ' +
      '(Schnittstellen, Entscheidungen, Blocker, Erkenntnisse anderer Subagents).',
    {},
    async () => text(JSON.stringify(engine.listTaskFindings(taskId), null, 2))
  )

  toolFn(
    'ask_orchestrator',
    'Stelle dem Orchestrator eine konkrete Rückfrage oder fordere Unterstützung an. ' +
      'Die Antwort enthält requestId; warte anschließend mit await_orchestrator_response.',
    {
      question: z.string().min(1).max(1_000),
      context: z.string().min(1).max(2_000).optional()
    },
    async (args) => {
      try {
        const request = engine.requestSubagentSupport(taskId, {
          question: String(args.question ?? ''),
          context: args.context ? String(args.context) : undefined
        })
        return text(JSON.stringify({ ok: true, requestId: request.id }))
      } catch (error) {
        return text(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }))
      }
    }
  )

  toolFn(
    'await_orchestrator_response',
    'Warte serverseitig auf die Antwort zu einer vorherigen ask_orchestrator-Rückfrage. ' +
      'Bei stillWaiting:true mit derselben requestId erneut aufrufen.',
    {
      requestId: z.string().min(1),
      timeoutMs: AWAIT_TIMEOUT_SHAPE
    },
    async (args) => {
      try {
        return text(JSON.stringify(await engine.awaitSubagentSupportResponse(
          String(args.requestId ?? ''),
          args.timeoutMs as number | undefined
        ), null, 2))
      } catch (error) {
        return text(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }))
      }
    }
  )

  toolFn(
    'permission_prompt',
    'Interner Claude-Permission-Callback. Die Tool-Eingabe bleibt in Vertragus und wird nie an Remote-Clients gesendet.',
    {
      tool_name: z.string().min(1).max(120),
      input: z.record(z.unknown())
    },
    async (args) => {
      const input = args.input && typeof args.input === 'object' && !Array.isArray(args.input)
        ? args.input as Record<string, unknown>
        : {}
      const allowed = await engine.requestToolPermission(taskId, String(args.tool_name ?? 'provider-tool'))
      return text(JSON.stringify(allowed
        ? { behavior: 'allow', updatedInput: input }
        : { behavior: 'deny', message: 'Vertragus permission denied or timed out.' }))
    }
  )

  return server
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

let started: McpServerHandle | null = null

/** Start (once) the MCP HTTP server and return its connection info. */
export async function startMcpServer(): Promise<McpServerHandle> {
  if (started) return started

  // sessionId -> transport (stateful; one session per orchestrator client)
  const transports = new Map<string, StreamableHTTPServerTransport>()
  const authToken = randomUUID()
  // Subagent sessions authenticate with their own token so a worker can never
  // open an orchestrator session (dispatching, plans) with its launch config.
  const subagentToken = randomUUID()

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
    const token = url.searchParams.get('token')
    const subagentTaskId = url.searchParams.get('subagentTask')
    const isSubagentSession = Boolean(subagentTaskId)
    const authorized = isSubagentSession
      ? token === subagentToken || token === authToken
      : token === authToken
    if (!authorized) {
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
        const requestedAgentId = url.searchParams.get('agentId')
        const clientIdentity = requestedAgentId
          ? agentManager.orchestratorClientIdentity(requestedAgentId)
          : undefined
        if (requestedAgentId && !clientIdentity) {
          throw new Error('Orchestrator-Verbindung verweist auf einen fremden oder beendeten Agent-Prozess.')
        }
        if (
          clientIdentity &&
          (clientIdentity.workspaceSessionId !== (workspaceSessionId ?? undefined) ||
            clientIdentity.engineId !== (requestedEngineId ?? undefined))
        ) {
          throw new Error('Orchestrator-Verbindung besitzt eine falsche Agent-/Session-/Engine-Korrelation.')
        }
        const server = isSubagentSession
          ? buildSubagentMcpServer(engine, subagentTaskId!)
          : buildMcpServer(engine, clientIdentity)
        await server.connect(transport)
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
    subagentUrl: `http://127.0.0.1:${port}/mcp?token=${encodeURIComponent(subagentToken)}`,
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
