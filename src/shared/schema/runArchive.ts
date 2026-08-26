/**
 * Archive / timeline DTOs — the panel's `runs:list` / `runs:get` payload and
 * the end-of-run fields on `meta.json`. Kept in shared so preload can import
 * them without pulling main.
 */
import type { AgentEvent } from './events'
import type { TaskBoardState } from './tasks'

export const RUN_END_REASONS = ['user_stop', 'retro', 'crash', 'unknown'] as const
export type RunEndReason = (typeof RUN_END_REASONS)[number]

/** One row of the profile archive. No journal body — that is `runs:get`. */
export interface RunListEntry {
  workspaceId: string
  workspaceName?: string
  goal?: string
  startedAt?: number
  endedAt?: number
  endReason?: RunEndReason
  pullRequestUrl?: string
  /** lastEvent.ts − startedAt, or endedAt − startedAt. Absent when we have no start. */
  durationMs?: number
  agentCount?: number
  /** `running` while meta has no endedAt and no crash event; else `stopped`. */
  status: 'running' | 'stopped'
  /** Named, never silent: a journal over the size cap was not scanned for counts. */
  skipped?: 'too_large'
}

/** Input to the timeline projection — one run's artefacts. */
export interface RunJournalView {
  workspaceId: string
  meta?: {
    workspaceId: string
    profileId: string
    workspaceName: string
    goal?: string
    startedAt: number
    resumedFrom?: string
    endedAt?: number
    endReason?: RunEndReason
    pullRequestUrl?: string
  }
  events: AgentEvent[]
  tasks?: TaskBoardState
  skipped?: 'too_large'
  journalBytes?: number
}
