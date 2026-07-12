/**
 * Agent runtime types shared across main / preload / renderer.
 */
import type { AgentProviderId } from './providers'

export type AgentKind = 'orchestrator' | 'sub'

/**
 * interactive = live PTY the user types into (Phase 1).
 * task = headless run dispatched by the orchestrator, streamed read-only (Phase 2).
 */
export type AgentMode = 'interactive' | 'task'

/** UI-facing status. `waiting` is reserved for approval detection (later). */
export type AgentStatus = 'running' | 'waiting' | 'stopped' | 'error'

export interface AgentUsage {
  costUsd?: number
  tokensIn?: number
  tokensOut?: number
  steps?: number
}

export interface AgentInstanceInfo {
  id: string
  /** Middle-earth code-name, e.g. "Boromir". */
  name: string
  provider: AgentProviderId
  model: string
  /** Display role, e.g. "Subagent · Backend / API". */
  role: string
  kind: AgentKind
  mode: AgentMode
  yolo: boolean
  /** For task agents: the orchestrator task that owns this run. */
  taskId?: string
  workingDir: string
  /** Set when the agent runs in an isolated git worktree. */
  worktree?: string
  status: AgentStatus
  pid?: number
  exitCode?: number
  startedAt: number
  /** Populated for providers that report structured headless usage. */
  usage?: AgentUsage
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
