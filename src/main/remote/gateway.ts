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
  startWorkspace(profileId: string): void | Promise<unknown>
  stopWorkspace(workspaceId: string): void | Promise<unknown>
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
  arg: string | undefined
): Promise<GatewayResult> {
  try {
    switch (name) {
      case 'workspaces:list':
        return { ok: true, result: host.listWorkspaces() }
      case 'profiles:list':
        return { ok: true, result: host.listProfiles() }
      case 'workspaces:start': {
        if (!arg) return { ok: false, error: 'workspaces:start needs a profileId' }
        await host.startWorkspace(arg)
        return { ok: true, result: { started: arg } }
      }
      case 'workspaces:stop': {
        if (!arg) return { ok: false, error: 'workspaces:stop needs a workspaceId' }
        await host.stopWorkspace(arg)
        return { ok: true, result: { stopped: arg } }
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
