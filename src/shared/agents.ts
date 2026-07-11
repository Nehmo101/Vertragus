/**
 * Agent runtime types shared across main / preload / renderer.
 */
import type { AgentProviderId } from './providers'

export type AgentKind = 'orchestrator' | 'sub'

/** UI-facing status. `waiting` is reserved for Phase 2 (approval detection). */
export type AgentStatus = 'running' | 'waiting' | 'stopped' | 'error'

export interface AgentInstanceInfo {
  id: string
  provider: AgentProviderId
  model: string
  /** Display role, e.g. "Subagent · Backend / API". */
  role: string
  kind: AgentKind
  yolo: boolean
  workingDir: string
  /** Set when the agent runs in an isolated git worktree. */
  worktree?: string
  status: AgentStatus
  pid?: number
  exitCode?: number
  startedAt: number
}

export interface SpawnAgentRequest {
  provider: AgentProviderId
  model: string
  role?: string
  kind?: AgentKind
  yolo?: boolean
  /** Defaults to the active profile's workingDir. */
  workingDir?: string
}

/** Lifecycle/dispatch feed entry (right panel "Dispatch-Protokoll"). */
export interface OrcaEvent {
  time: number
  text: string
  tone: 'dispatch' | 'info' | 'warn' | 'error' | 'success' | 'yolo' | 'muted'
}

export interface AgentDataChunk {
  id: string
  data: string
  /** Monotonic per-agent sequence — lets terminals replay buffer without dupes. */
  seq: number
}

export interface AgentBufferSnapshot {
  data: string
  seq: number
}
