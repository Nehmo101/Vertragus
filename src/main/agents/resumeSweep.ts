/**
 * Periodic resume-state persistence, extracted from AgentManager (audit A2):
 * the last-known state (info + scrollback tail) of every session-bound agent
 * is written per workspace session, so a crash loses at most one sweep
 * interval of terminal history. AgentManager keeps facade methods with the
 * frozen public signatures (sessionRestore mocks them by name).
 */
import type { AgentInstanceInfo } from '@shared/agents'
import { buildAgentResumeState } from '@main/agents/resumeState'
import type { AgentStatePersistence } from '@main/config/sessionStore'

export interface ResumeSweepSource {
  listSessionAgents(): Iterable<{ info: AgentInstanceInfo; scrollback: string }>
}

export class ResumeSweep {
  private timer: ReturnType<typeof setInterval> | undefined

  constructor(
    private readonly source: ResumeSweepSource,
    private readonly defaultStore: AgentStatePersistence
  ) {}

  persist(store: AgentStatePersistence = this.defaultStore): void {
    const bySession = new Map<string, ReturnType<typeof buildAgentResumeState>[]>()
    const capturedAt = Date.now()
    for (const { info, scrollback } of this.source.listSessionAgents()) {
      const sessionId = info.workspaceSessionId
      if (!sessionId) continue
      const states = bySession.get(sessionId) ?? []
      states.push(buildAgentResumeState(info, scrollback, capturedAt))
      bySession.set(sessionId, states)
    }
    for (const [sessionId, agents] of bySession) {
      try {
        store.writeAgentResumeStates(sessionId, agents)
      } catch (error) {
        console.warn('[Agents] resume-state persistence failed', sessionId, error)
      }
    }
  }

  /** Start the periodic sweep (idempotent; runtime only). */
  start(intervalMs = 30_000): void {
    if (this.timer) return
    this.timer = setInterval(() => this.persist(), intervalMs)
    this.timer.unref?.()
  }
}
