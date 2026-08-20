/**
 * The wire protocol between Vertragus and a remote browser client.
 *
 * Shared by both sides: the main-process remote server validates inbound
 * messages against these schemas, and the web client imports the types so a
 * protocol change is one edit, caught by the compiler on both ends.
 *
 * Two transports, one auth domain:
 * - `POST /api/auth { pairingToken }` → `{ session }` (rate-limited).
 * - one WebSocket `/ws` per client; it authenticates with its first frame
 *   (browsers cannot set WS request headers), then multiplexes terminals and
 *   commands.
 *
 * The command surface is a deliberate allow-list — Vertragus subagents run
 * with `--dangerously-skip-permissions`, so remote control is remote code
 * execution, and only these few verbs are exposed. Focus/window/zone ops,
 * settings writes and profile/provider editing are intentionally absent.
 */
import { z } from 'zod'

/** Commands a remote client may invoke — the whole surface, nothing implicit. */
export const REMOTE_COMMANDS = [
  'workspaces:list',
  'workspaces:start',
  'workspaces:stop',
  'profiles:list',
  // H1: answer an agent's open MCP question over the same host path the
  // orchestrator's send_to_agent{questionId} takes. One extra verb, no second
  // question registry, no new orchestration surface.
  'answer_question'
] as const
export type RemoteCommand = (typeof REMOTE_COMMANDS)[number]

// --- inbound (client → server) ------------------------------------------

export const clientMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('auth'), session: z.string().min(1).max(512) }),
  z.object({ type: z.literal('attach'), agentId: z.string().min(1).max(200) }),
  z.object({ type: z.literal('detach'), agentId: z.string().min(1).max(200) }),
  z.object({
    type: z.literal('input'),
    agentId: z.string().min(1).max(200),
    data: z.string().max(64_000)
  }),
  z.object({
    type: z.literal('resize'),
    agentId: z.string().min(1).max(200),
    cols: z.number().int().positive().max(2000),
    rows: z.number().int().positive().max(2000)
  }),
  z.object({
    type: z.literal('command'),
    id: z.string().min(1).max(200),
    name: z.enum(REMOTE_COMMANDS),
    // Command args are validated per-command in the gateway; kept loose here.
    arg: z.string().max(400).optional(),
    /**
     * Structured command arguments (string values only). `arg` predates this
     * and stays for the single-id commands; anything with more than one field
     * (start goal, answer_question) travels here. Caps bound a hostile frame,
     * the gateway validates per command.
     */
    args: z.record(z.string().max(64), z.string().max(20_000)).optional()
  }),
  z.object({ type: z.literal('refresh') })
])
export type ClientMessage = z.infer<typeof clientMessageSchema>

// --- outbound (server → client) -----------------------------------------

/** One agent row a remote client renders — mirrors the panel's summary. */
export interface RemoteAgentSummary {
  agentId: string
  name: string
  roleId: string
  roleLabel?: string
  roleColor: string
  state: 'working' | 'waiting' | 'stopped'
  pendingQuestion?: string
  /** Registry id of that open question — what `answer_question` addresses. */
  pendingQuestionId?: string
}

export interface RemoteWorkspaceSummary {
  workspaceId: string
  name: string
  profileId: string
  profileName?: string
  active: boolean
  taskText?: string
  /** Goal the workspace was started with (H2); absent = "no goal" hint. */
  goalText?: string
  agents: RemoteAgentSummary[]
}

export interface RemoteProfileSummary {
  id: string
  name: string
  repoPath: string
}

export type ServerMessage =
  | {
      type: 'hello'
      workspaces: RemoteWorkspaceSummary[]
      locale: string
      theme: 'dark' | 'light'
    }
  | { type: 'workspaces'; workspaces: RemoteWorkspaceSummary[] }
  | {
      type: 'snapshot'
      agentId: string
      snapshot: string
      cols: number
      rows: number
      name: string
      roleColor: string
      exitCode: number | null
    }
  | { type: 'data'; agentId: string; data: string }
  | { type: 'exit'; agentId: string; exitCode: number | null }
  | { type: 'command_result'; id: string; ok: true; result: unknown }
  | { type: 'command_result'; id: string; ok: false; error: string }
  | { type: 'error'; message: string }
  | { type: 'session_revoked' }

/** Parse one inbound frame; returns undefined for anything malformed. */
export function parseClientMessage(raw: string): ClientMessage | undefined {
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch {
    return undefined
  }
  const result = clientMessageSchema.safeParse(json)
  return result.success ? result.data : undefined
}
