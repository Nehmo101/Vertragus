import type { AutoPrConfig } from '@shared/profile'
import type { TaskGateFinding } from '@shared/orchestrator'
import type { RemoteCiOutcome } from './ciMonitor'

export interface PreparedTaskChange {
  taskId: string
  title: string
  worktree: string
  branch: string
  commit: string
  commits: string[]
  files: string[]
}

export interface AutoPrOutcome {
  status: 'skipped' | 'prepared' | 'published' | 'blocked'
  message: string
  url?: string
  branch?: string
  worktree?: string
  remoteCi?: RemoteCiOutcome
}

export interface PrepareTaskInput {
  config: AutoPrConfig
  /** Enforce the worker commit contract even when PR publishing is disabled. */
  commitOnly?: boolean
  /** HEAD captured before the worker process started. */
  baseCommit?: string
  taskId: string
  title: string
  worktree?: string
}

export interface PublishInput {
  config: AutoPrConfig
  goalId: string
  goalTitle: string
  changes: PreparedTaskChange[]
  /** Profile-bound default branch when autoPr.baseBranch is empty. */
  profileDefaultBranch?: string
  onRemoteCiUpdate?: (outcome: RemoteCiOutcome) => void
}

export type PrepareTaskResult = AutoPrOutcome & {
  result: 'disabled' | 'unavailable' | 'no-changes' | 'committed' | 'needs-work' | 'blocked'
  noChanges?: boolean
  change?: PreparedTaskChange
  findings?: TaskGateFinding[]
  /** True when the block was caused by missing gate tooling, not by the change itself. */
  infrastructure?: boolean
}
