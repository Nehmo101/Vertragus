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
import { MAX_RESUME_TAIL_CHARS } from './limits'

// Re-exported so a host-side reader finds it beside the schema that uses it.
export { MAX_RESUME_TAIL_CHARS }

/** Commands a remote client may invoke — the whole surface, nothing implicit. */
export const REMOTE_COMMANDS = [
  'workspaces:list',
  'workspaces:start',
  'workspaces:stop',
  'profiles:list',
  // H1: answer an agent's open MCP question over the same host path the
  // orchestrator's send_to_agent{questionId} takes. One extra verb, no second
  // question registry, no new orchestration surface. Since D3 it also answers
  // the orchestrator's ask_user questions (reserved agentId "user").
  'answer_question',
  // D2: steer the run — visible in the orchestrator terminal and pushed as a
  // user_message event that wakes its parked await_events. Distinct from raw
  // terminal `input`, which only reaches the CLI's own prompt.
  'user_message'
] as const
export type RemoteCommand = (typeof REMOTE_COMMANDS)[number]


// --- inbound (client → server) ------------------------------------------

export const clientMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('auth'), session: z.string().min(1).max(512) }),
  z.object({
    type: z.literal('attach'),
    agentId: z.string().min(1).max(200),
    /**
     * The tail of this agent's output the client already holds, offered so the
     * bridge can answer with the part that is new instead of the whole
     * scrollback. See {@link MAX_RESUME_TAIL_CHARS}; omitted on a first attach,
     * and ignorable — a bridge that does not understand it simply replays
     * everything, which is what every attach did before this field existed.
     */
    resume: z.string().max(MAX_RESUME_TAIL_CHARS).optional()
  }),
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
  /**
   * F: 'orchestrator' for the root row, 'lead' for sub-orchestrators, the
   * role id otherwise. Drives the panel's indentation and lead styling.
   */
  kind?: string
  /** F: the lead this agent works under; absent for direct children. */
  parentId?: string
  /** Short activity note ("plant", "T-142"). Absent = derived from `state`. */
  statusText?: string
  pendingQuestion?: string
  /** Registry id of that open question — what `answer_question` addresses. */
  pendingQuestionId?: string
}

/**
 * S4: one row of the run's task board as it reaches a paired browser. The
 * gateway forwards the panel's summary verbatim, so the board travels whether
 * or not a client draws it — declaring it here is what makes that a documented
 * part of the wire rather than an undeclared field riding along by accident.
 * Mirrors the panel's `WorkspaceTaskSummary`; the gateway test pins the two
 * structs together at compile time.
 */
export interface RemoteTaskSummary {
  taskId: string
  subject: string
  /** Tombstones never travel — the summary carries the living plan only. */
  status: 'pending' | 'in_progress' | 'completed'
  /** Agent id of the owner; resolved to its Commedia name from `agents`. */
  ownerAgentId?: string
  blockedBy: string[]
  /** pending AND every blockedBy completed — the board's own readiness rule. */
  ready: boolean
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
  /** C5: orchestrator alive but silent on its tools — the card shows a hint. */
  orchestratorIdle?: boolean
  /** D3: the orchestrator's open ask_user question (answer with agentId "user"). */
  userQuestion?: { questionId: string; question: string }
  agents: RemoteAgentSummary[]
  /**
   * S4: the run's task board, capped and tombstone-free by the panel. Absent
   * while the run has no plan. Optional because a run without a plan has no
   * board, not because a client may drop it in transit.
   */
  tasks?: RemoteTaskSummary[]
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
      /**
       * The agent's output as the bridge holds it. Normally the whole
       * scrollback; when the `attach` carried a resume marker the bridge could
       * place, this is the stream from that marker on — still a view of the
       * same stream, still containing the client's own tail, so a client that
       * aligns on its tail and appends what follows behaves identically.
       *
       * Lossless in practice rather than by construction: the bridge resumes
       * from the LAST place the marker occurs, so a marker that recurs after
       * the client's true position would drop the output in between. It takes
       * a terminal emitting the same 16 KB twice, and the client's own 8 KB
       * aligner has the identical shape, so this is a stated residual risk and
       * not a new one — see `resumeSnapshot` in `terminalBridge.ts`.
       */
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
  /**
   * The session this socket authenticated with is gone. `reason` says whether
   * that was a DECISION about this device or merely its clock running out,
   * because the two want opposite client behaviour: an expired session should
   * be replaced silently from the stored pairing token (a desktop restart drops
   * every in-memory session and must not send every phone back to the QR
   * code), while a revoke the user performed in settings must not be undone by
   * the revoked device re-pairing itself a second later.
   *
   * Optional so an older client — which ignores unknown fields and re-pairs
   * either way — is not broken by a newer host; a client that understands it
   * treats a missing value as `'expired'`.
   *
   * ## `'revoked'` is device management, not a security boundary
   *
   * Read the paragraph above literally: the revoke holds because the CLIENT
   * chooses to honour it by deleting its own stored pairing token. Nothing on
   * the host stops a device from presenting that same token to `/api/auth` a
   * second later and being issued a fresh session, because the host has no way
   * to tell one holder of the pairing token from another. So revoking a lost
   * phone from settings ends its current session and drops it off the
   * connected-clients list; it does not end its ACCESS. Regenerating the
   * pairing token is the only revocation that holds against a client that does
   * not cooperate, and it costs every other device a re-pair.
   *
   * The real fix is small and is written down here so the next person does not
   * have to re-derive it: mint a device id at pair time, return it beside the
   * session, have the client present it on every subsequent `/api/auth`, and
   * keep a revoked-device set the host checks before minting. That is a
   * protocol change on both ends plus persistence for the revoked set, which is
   * why the shipped fix stops at making the reason honest.
   */
  | { type: 'session_revoked'; reason?: 'revoked' | 'expired' }

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
