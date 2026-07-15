/** Node-free Mission Control contracts shared by Electron and the mobile PWA. */
import type { OrchestratorSnapshot, OrcaTask, PendingPlanReview } from './orchestrator'

export const REMOTE_CAPABILITIES = ['read', 'steer', 'admin', 'diff', 'push', 'speech'] as const
export type RemoteCapability = (typeof REMOTE_CAPABILITIES)[number]

export const REMOTE_COMMAND_IDS = [
  'plan.approve',
  'plan.reject',
  'mode.enableAuto',
  'run.reset',
  'goal.submit',
  'publication.approve',
  'publication.reject',
  'task.diff',
  'killSwitch.activate'
] as const
export type RemoteCommandId = (typeof REMOTE_COMMAND_IDS)[number]

export interface RemoteCommandEnvelope {
  id: RemoteCommandId | string
  args: unknown
  requestId?: string
}

export type ApprovalKind = 'plan-review' | 'task-blocked' | 'pr-publication'

export interface ApprovalItem {
  id: string
  kind: ApprovalKind
  profileId: string
  workspaceSessionId: string
  title: string
  summary: string
  createdAt: number
  plan?: PendingPlanReview
  task?: OrcaTask
  actions: RemoteCommandId[]
}

export interface DeviceInfo {
  id: string
  name: string
  capabilities: RemoteCapability[]
  createdAt: number
  lastSeenAt?: number
  revokedAt?: number
}

export interface PairingChallenge {
  code: string
  expiresAt: number
  pairingUrl?: string
  qrDataUrl?: string
}

export interface PairingResult {
  token: string
  device: DeviceInfo
}

export type RemoteEventFrame =
  | { type: 'snapshot'; at: number; snapshot: OrchestratorSnapshot }
  | { type: 'approvals'; at: number; approvals: ApprovalItem[] }
  | { type: 'event'; at: number; event: { kind: string; message: string } }
  | { type: 'ping'; at: number }

export type RemoteTunnelState = 'disabled' | 'starting' | 'online' | 'degraded' | 'error'

export interface RemoteStatus {
  enabled: boolean
  gatewayRunning: boolean
  gatewayPort?: number
  tunnel: RemoteTunnelState
  tunnelMode?: 'named' | 'quick'
  publicUrl?: string
  deviceCount: number
  error?: string
}

export interface RemoteEnableRequest {
  /** Stable public hostname configured for the named Cloudflare Tunnel. */
  hostname?: string
  /** Named-tunnel token; accepted only by desktop IPC and encrypted immediately. */
  tunnelToken?: string
  /** Explicit development/fallback mode. URL is ephemeral and still treated as public. */
  quickTunnel?: boolean
}

export interface RemotePairStartRequest {
  capabilities?: RemoteCapability[]
  deviceNameHint?: string
}
