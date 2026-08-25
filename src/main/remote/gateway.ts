/**
 * The remote command gateway: the explicit, exhaustive allow-list of what a
 * paired browser client may do to the running app.
 *
 * This is the security boundary that matters most. Vertragus subagents run
 * with `--dangerously-skip-permissions`, so "remote control" is "remote code
 * execution on the user's machine" — the gateway therefore exposes a handful
 * of verbs and nothing else. Anything a remote user could use to change the
 * app's configuration or reach outside the workspace lifecycle (settings
 * writes, profile/provider editing, focus/window/zone ops, worktree deletion,
 * updates) is deliberately NOT here. Adding a command is a deliberate act with
 * a test, never an incidental mirror of an IPC channel.
 */
import type { RemoteCommand, RemoteProfileSummary, RemoteWorkspaceSummary } from '@shared/remote/protocol'

/** The read models the gateway needs. Implemented over the app's directories. */
export interface RemoteGatewayHost {
  listWorkspaces(): RemoteWorkspaceSummary[]
  listProfiles(): RemoteProfileSummary[]
  /** `goal` (H2) is seeded into the orchestrator; absent = classic bare start. */
  startWorkspace(profileId: string, goal?: string): void | Promise<unknown>
  stopWorkspace(workspaceId: string): void | Promise<unknown>
  /**
   * Answer one agent question (H1) — the SAME host path as the orchestrator's
   * `send_to_agent{questionId}`, so answering from the phone resolves the very
   * `ask_orchestrator` waiter the MCP tool would. Must reject/throw on failure
   * (unknown question, wrong agent, PTY delivery failed).
   */
  answerQuestion(input: {
    workspaceId: string
    agentId: string
    questionId: string
    text: string
  }): void | Promise<unknown>
  /**
   * D2: steer the run. Visible in the orchestrator terminal, pushed as a
   * `user_message` event that wakes a parked `await_events`. Must throw on an
   * unknown workspace or a dead orchestrator.
   */
  userMessage(input: {
    workspaceId: string
    text: string
    targetAgentId?: string
  }): void | Promise<unknown>
  /**
   * H2 refill: the goal of a run that was started bare — the same host path
   * the start goal takes (`Workspace.assignGoal`). Must throw on an unknown
   * workspace, a dead orchestrator, a CLI that refused the text, and on a run
   * that already carries a goal: this verb hands out a first user turn, it
   * never rewrites one.
   */
  assignGoal(input: { workspaceId: string; goal: string }): void | Promise<unknown>
}

export type GatewayResult =
  | { ok: true; result: unknown }
  | { ok: false; error: string }

/**
 * Run one allow-listed command. Unknown names cannot reach here (the protocol
 * enum gates them), but the switch is exhaustive so a new enum member is a
 * compile error until it is handled — no command is ever silently unhandled.
 */
export async function runRemoteCommand(
  host: RemoteGatewayHost,
  name: RemoteCommand,
  arg: string | undefined,
  args?: Readonly<Record<string, string>>
): Promise<GatewayResult> {
  try {
    switch (name) {
      case 'workspaces:list':
        return { ok: true, result: host.listWorkspaces() }
      case 'profiles:list':
        return { ok: true, result: host.listProfiles() }
      case 'workspaces:start': {
        // `arg` stays the profileId for old clients; `args` adds the goal (H2).
        const profileId = args?.profileId?.trim() || arg
        if (!profileId) return { ok: false, error: 'workspaces:start needs a profileId' }
        const goal = args?.goal?.trim() || undefined
        await (goal ? host.startWorkspace(profileId, goal) : host.startWorkspace(profileId))
        return { ok: true, result: { started: profileId, ...(goal ? { goal: true } : {}) } }
      }
      case 'workspaces:stop': {
        if (!arg) return { ok: false, error: 'workspaces:stop needs a workspaceId' }
        await host.stopWorkspace(arg)
        return { ok: true, result: { stopped: arg } }
      }
      case 'answer_question': {
        const workspaceId = args?.workspaceId?.trim()
        const agentId = args?.agentId?.trim()
        const questionId = args?.questionId?.trim()
        const text = args?.text?.trim()
        if (!workspaceId || !agentId || !questionId || !text) {
          return {
            ok: false,
            error: 'answer_question needs args {workspaceId, agentId, questionId, text}'
          }
        }
        await host.answerQuestion({ workspaceId, agentId, questionId, text })
        return { ok: true, result: { answered: questionId, agentId } }
      }
      case 'workspaces:goal': {
        const workspaceId = args?.workspaceId?.trim()
        const goal = args?.goal?.trim()
        if (!workspaceId || !goal) {
          return { ok: false, error: 'workspaces:goal needs args {workspaceId, goal}' }
        }
        await host.assignGoal({ workspaceId, goal })
        return { ok: true, result: { goal: workspaceId } }
      }
      case 'user_message': {
        const workspaceId = args?.workspaceId?.trim()
        const text = args?.text?.trim()
        const targetAgentId = args?.targetAgentId?.trim()
        if (!workspaceId || !text) {
          return { ok: false, error: 'user_message needs args {workspaceId, text}' }
        }
        await host.userMessage({
          workspaceId,
          text,
          ...(targetAgentId ? { targetAgentId } : {})
        })
        return { ok: true, result: { delivered: workspaceId } }
      }
      default: {
        // Exhaustiveness guard: a new RemoteCommand must be handled above.
        const unreachable: never = name
        return { ok: false, error: `unhandled command ${String(unreachable)}` }
      }
    }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}
