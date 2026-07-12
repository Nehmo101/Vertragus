/**
 * Agent runtime types shared across main / preload / renderer.
 */
import type { AgentProviderId, ProviderId } from './providers'

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

/**
 * Which kind of provider usage limit an agent appears to be hitting. Best-effort:
 * detection is heuristic (matched against the agent's terminal output), because
 * the CLIs expose no queryable remaining quota. `generic` = a limit signal was
 * seen but its type couldn't be classified.
 */
export type LimitKind = 'session-5h' | 'weekly' | 'weekly-fable' | 'generic'

/** Human-readable German labels per limit kind (shared main + renderer). */
export const LIMIT_KIND_LABELS: Record<LimitKind, string> = {
  'session-5h': '5-Stunden-Limit',
  weekly: 'Wochenlimit',
  'weekly-fable': 'Fable-Wochenlimit',
  generic: 'Nutzungslimit'
}

export interface LimitWarning {
  kind: LimitKind
  /** Epoch ms when the limit signal was first detected in the agent's output. */
  detectedAt: number
  /** Short human-readable hint (the matched phrase / kind label). */
  note?: string
}

/** A handoff relationship end-point (the other agent involved). */
export interface HandoffLink {
  id: string
  name: string
  at: number
}

export interface AgentInstanceInfo {
  id: string
  /** Middle-earth code-name, e.g. "Boromir". */
  name: string
  provider: ProviderId
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
  /** Set once a usage-limit signal is detected in this agent's output. */
  limitWarning?: LimitWarning
  /** Set on the outgoing agent once its work was handed off to another agent. */
  handoffTo?: HandoffLink
  /** Set on a newly spawned agent that took over from another agent. */
  handoffFrom?: HandoffLink
}

export interface SpawnAgentRequest {
  provider: AgentProviderId
  model: string
  role?: string
  kind?: AgentKind
  yolo?: boolean
  /** Defaults to the active profile's workingDir. */
  workingDir?: string
  /**
   * Whether to run the agent in its own isolated git worktree. Defaults to the
   * global `worktreeIsolation` setting. Set `false` for a handoff so the taking-
   * over agent continues in the source agent's existing working tree.
   */
  isolateWorktree?: boolean
}

/** Request to hand an interactive agent's live work over to a fresh agent. */
export interface HandoffRequest {
  /** The agent whose work is being handed off (e.g. "Gandalf"). */
  sourceId: string
  /** Provider of the taking-over agent (e.g. "codex"). */
  provider: AgentProviderId
  /** Model of the taking-over agent; empty = the CLI's own default. */
  model: string
  /** Optional role/label for the new agent. */
  role?: string
  yolo?: boolean
  /** The task the new agent should continue (prefilled from the goal). */
  task?: string
  /** Optional free-text note on the current state / what's done. */
  summary?: string
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
