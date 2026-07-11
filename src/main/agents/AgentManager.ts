/**
 * AgentManager — owns the lifecycle of every running agent instance.
 *
 * Phase 1 will back each agent with a node-pty process (see providers/types.ts
 * buildInteractiveLaunch) and stream its output over IPC to an xterm.js pane,
 * with per-agent git-worktree isolation. This stub establishes the structure.
 */
import type { AgentProviderId } from '@shared/providers'

export interface AgentInstance {
  id: string
  provider: AgentProviderId
  model?: string
  role: string
  workingDir: string
  yolo: boolean
  status: 'idle' | 'running' | 'waiting' | 'error' | 'stopped'
}

export class AgentManager {
  private readonly agents = new Map<string, AgentInstance>()

  list(): AgentInstance[] {
    return [...this.agents.values()]
  }

  // TODO(phase1): spawn(opts) -> node-pty, write(id, data), resize(id, cols, rows),
  // stop(id), stopAll() (global kill-switch).
}

export const agentManager = new AgentManager()
