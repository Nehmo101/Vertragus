import type { AgentEvent } from './schema/events'
import type { TaskBoardState } from './schema/tasks'

export type { SeatOverride as AgentSuccessor, ReseatInput as AgentReseatInput } from './schema/reseat'
import type { AgentSeat } from './schema/reseat'

export interface RecoveryBranch {
  branch: string
  head?: string
  path: string
  dirty?: boolean
  ahead?: number
  root: boolean
  changedFiles?: string[]
}
export interface RunRecovery {
  workspaceId: string
  baseBranch?: string
  seat?: AgentSeat
  branches: RecoveryBranch[]
  tasks?: TaskBoardState
}
export interface RunFinalization {
  status: 'pending' | 'running' | 'failed' | 'completed'
  updatedAt: number
  attempts: number
  error?: string
  url?: string
}
export interface RunReview extends RunRecovery {
  events: AgentEvent[]
  finalization?: RunFinalization
}
