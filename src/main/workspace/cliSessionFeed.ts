/**
 * Build the session chrome snapshot for every live agent of a workspace.
 *
 * Lives next to the workspace layer (not in shared) because it reads
 * Workspace + MCP question/task lookups. The snapshot shape itself is
 * `@shared/cliSession` — the renderer never talks to Workspace.
 */
import { buildCliSession, type CliSession, type CliSessionKind, type CliSessionState } from '@shared/cliSession'
import type { AgentEvent } from '@shared/schema/events'

export interface CliSessionAgentRow {
  agentId: string
  status: string
  branch?: string
  kind?: string
}

export interface CliSessionWorkspace {
  workspaceId: string
  orchestrator?: { agentId: string; branch: string }
  orchestratorAlive: boolean
  orchestratorIdle: boolean
  orchestratorTaskText?: string
  listAgents(): CliSessionAgentRow[]
  events: { all(): AgentEvent[] }
}

export interface CliSessionMcp {
  agentTask(workspaceId: string, agentId: string): string | undefined
  openQuestion(
    workspaceId: string,
    agentId: string
  ): { questionId: string; question: string } | undefined
}

export interface CliChromePush {
  agentId: string
  task: string | undefined
  session: CliSession
}

function panelState(status: string): CliSessionState {
  if (status === 'working') return 'working'
  if (status === 'starting') return 'waiting'
  return 'stopped'
}

function sessionKind(kind: string | undefined, orchestrator: boolean): CliSessionKind {
  if (orchestrator) return 'orchestrator'
  if (kind === 'lead') return 'lead'
  return 'agent'
}

/**
 * One push per window: the orchestrator (when it exists) then every listed
 * subagent. Task notes stay the same values the title-bar hover already uses.
 */
export function cliChromeForWorkspace(
  ws: CliSessionWorkspace,
  mcp: CliSessionMcp
): CliChromePush[] {
  const events = ws.events.all()
  const rows: CliChromePush[] = []
  const orch = ws.orchestrator
  if (orch) {
    rows.push({
      agentId: orch.agentId,
      task: ws.orchestratorTaskText,
      session: buildCliSession({
        workspaceId: ws.workspaceId,
        agentId: orch.agentId,
        state: ws.orchestratorAlive ? 'working' : 'stopped',
        kind: 'orchestrator',
        branch: orch.branch,
        idle: ws.orchestratorIdle,
        pendingQuestion: mcp.openQuestion(ws.workspaceId, orch.agentId),
        userQuestion: mcp.openQuestion(ws.workspaceId, 'user'),
        events
      })
    })
  }
  for (const agent of ws.listAgents()) {
    rows.push({
      agentId: agent.agentId,
      task: mcp.agentTask(ws.workspaceId, agent.agentId),
      session: buildCliSession({
        workspaceId: ws.workspaceId,
        agentId: agent.agentId,
        state: panelState(agent.status),
        kind: sessionKind(agent.kind, false),
        branch: agent.branch,
        pendingQuestion: mcp.openQuestion(ws.workspaceId, agent.agentId),
        events
      })
    })
  }
  return rows
}

/** The workspace whose orchestrator or listed agent owns this id. */
export function workspaceOwningAgent<T extends CliSessionWorkspace>(
  workspaces: readonly T[],
  agentId: string
): T | undefined {
  return workspaces.find(
    (ws) =>
      ws.orchestrator?.agentId === agentId ||
      ws.listAgents().some((agent) => agent.agentId === agentId)
  )
}
