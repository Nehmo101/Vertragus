/**
 * Agent runtime types shared across main / preload / renderer.
 */
import type { AgentProviderId, ProviderId } from './providers'
import type { ModelPreset } from './models'
import type { PanePreflightReport } from './orchestrator'

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

export type HandoffHandshakePhase =
  | 'awaiting-context'
  | 'awaiting-ack'
  | 'completing'
  | 'completed'
  | 'failed'

export interface HandoffHandshakeInfo {
  /** Opaque correlation id for this concrete handoff attempt. */
  id: string
  phase: HandoffHandshakePhase
  updatedAt: number
  /** Present only for a terminal failure; the source remains alive. */
  error?: string
}

/** A handoff relationship end-point (the other agent involved). */
export interface HandoffLink {
  id: string
  name: string
  at: number
  /** Orchestrator-only explicit knowledge-transfer/shutdown handshake. */
  handshake?: HandoffHandshakeInfo
}

export interface AgentInstanceInfo {
  id: string
  /** Workspace profile that owns this agent. Omitted for global utility panes such as logins. */
  profileId?: string
  /** Concrete runtime session within the workspace profile. */
  workspaceSessionId?: string
  /** Engine identity is the single authority for task, pane and status routing. */
  engineId?: string
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
  /** Stable profile role when this pane belongs to the prestarted workspace team. */
  teamRole?: string
  workingDir: string
  /** Set when the agent runs in an isolated git worktree. */
  worktree?: string
  /** Effective branch for the isolated worktree, when Git isolation is active. */
  branch?: string
  /** Last dispatch preflight that qualified this pane/worktree for execution. */
  preflight?: PanePreflightReport
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

/**
 * Persisted last-known state of a session-bound agent, captured periodically
 * and during the ordered shutdown. After a restart it seeds handoff briefings
 * ("continue exactly where the previous agent stopped") and lets the UI show
 * the frozen terminal history. Never contains a live process handle.
 */
export interface AgentResumeState {
  /** Redacted copy of the agent's public info (without the bulky preflight report). */
  info: AgentInstanceInfo
  /** ANSI-stripped, secret-redacted tail of the terminal scrollback. */
  scrollbackTail: string
  capturedAt: number
}

export interface SpawnAgentRequest {
  provider: AgentProviderId
  /** Free-text override; empty uses modelPreset or CLI default. */
  model: string
  modelPreset?: ModelPreset
  role?: string
  kind?: AgentKind
  /**
   * Efficiency-Solo launch: attach the minimal solo MCP session (report/retro)
   * plus the compact solo system prompt instead of subagent MCP wiring.
   * Ignored for orchestrators.
   */
  solo?: boolean
  yolo?: boolean
  /** Marks an interactive profile agent as reusable capacity for this orchestrator role. */
  teamRole?: string
  /** Workspace ownership used for background session routing. */
  profileId?: string
  /** Concrete session created when the workspace team starts. */
  workspaceSessionId?: string
  /** Engine that owns all task/status operations for this pane. */
  engineId?: string
  /** Defaults to the active profile's workingDir. */
  workingDir?: string
  /**
   * Whether to run the agent in its own isolated git worktree. Defaults to the
   * global `worktreeIsolation` setting. Set `false` for a handoff so the taking-
   * over agent continues in the source agent's existing working tree.
   */
  isolateWorktree?: boolean
  /**
   * Ask the provider CLI to natively resume the working directory's most
   * recent conversation (restart recovery). Ignored for providers without a
   * safe, cwd-scoped resume capability.
   */
  resumeConversation?: boolean
}

/** Request to hand an interactive agent's live work over to a fresh agent. */
export interface HandoffRequest {
  /** The agent whose work is being handed off (e.g. "Virgilio"). */
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

/** Request to hand several live interactive agents to the same provider/model. */
export interface BulkHandoffRequest {
  /** Explicit source ids selected by the renderer. Every source is handled independently. */
  sourceIds: string[]
  provider: AgentProviderId
  model: string
  role?: string
  yolo?: boolean
  task?: string
  summary?: string
  /** Stop successfully transferred subagents. Orchestrators still use their acknowledgement handshake. */
  stopSources?: boolean
}

export interface BulkHandoffFailure {
  sourceId: string
  sourceName?: string
  error: string
}

export interface BulkHandoffResult {
  requested: number
  transferred: AgentInstanceInfo[]
  failures: BulkHandoffFailure[]
}

/** Lifecycle/dispatch feed entry (right panel "Dispatch-Protokoll"). */
export interface VertragusEvent {
  time: number
  text: string
  tone: 'dispatch' | 'info' | 'warn' | 'error' | 'success' | 'yolo' | 'muted'
  /** Workspace-scoped events remain attached while another workspace is visible. */
  profileId?: string
  workspaceSessionId?: string
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
