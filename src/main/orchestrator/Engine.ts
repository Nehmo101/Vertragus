/**
 * OrchestratorEngine — drives an orchestrator agent that decomposes work into
 * subtasks and dispatches them to subagents.
 *
 * Phase 2 will expose an MCP server (OrcaMcpServer) with dispatch_subagent /
 * open_subwindow / list_subagents tools, maintain a task DAG, and route results
 * back to the orchestrator. This stub establishes the structure.
 */
import type { AgentProviderId } from '@shared/providers'

export interface OrchestratorTask {
  id: string
  prompt: string
  assignedRole?: string
  status: 'queued' | 'dispatched' | 'running' | 'done' | 'failed'
  dependsOn: string[]
  result?: string
}

export class OrchestratorEngine {
  private readonly tasks = new Map<string, OrchestratorTask>()

  tasksList(): OrchestratorTask[] {
    return [...this.tasks.values()]
  }

  // TODO(phase2): start(orchestrator, subagents), onDispatch(role, prompt),
  // openSubwindow(role), and DAG scheduling.
}

export const orchestratorEngine = new OrchestratorEngine()

export type { AgentProviderId }
