/** Node-free Mission Control contracts shared by Electron and the mobile PWA. */
import type { OrchestratorSnapshot, OrcaTask, PendingPlanReview } from './orchestrator'

export const REMOTE_CAPABILITIES = [
  'read',
  'steer',
  'admin',
  'diff',
  'push',
  'speech',
  'approve-tools',
  'budget',
  'task-control',
  'replan',
  'provider-fallback'
] as const
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
  'permission.allow',
  'permission.deny',
  'budget.setCaps',
  'task.pause',
  'task.resume',
  'task.fallback',
  'plan.replan',
  'killSwitch.activate'
] as const
export type RemoteCommandId = (typeof REMOTE_COMMAND_IDS)[number]

export interface RemoteCommandEnvelope {
  id: RemoteCommandId | string
  args: unknown
  requestId?: string
}

export type ApprovalKind =
  | 'plan-review'
  | 'task-blocked'
  | 'pr-publication'
  | 'tool-permission'
  | 'budget-exceeded'
  | 'provider-limit'

export interface RemoteActor {
  /** Stable app-account id. For Cloudflare Access this is the verified lower-case email. */
  id: string
  displayName: string
}

export interface RemoteScope {
  profileId: string
  /** Exact workspace-session ids visible to this account. Empty means no existing session access. */
  sessionIds: string[]
  /** Separately grants goal.submit for this profile; never inferred from read access. */
  allowGoalSubmit: boolean
}

export interface PermissionRequest {
  id: string
  provider: 'claude' | 'kimi' | 'codex' | 'cursor' | 'copilot' | 'ollama'
  agentId: string
  taskId?: string
  profileId?: string
  workspaceSessionId?: string
  engineId?: string
  tool: string
  summary: string
  createdAt: number
  expiresAt: number
}

export interface RemoteBudgetCaps {
  maxTokens?: number
  maxCostUsd?: number
}

export interface RemoteBudgetSnapshot {
  tokens: number
  costUsd: number
  caps: RemoteBudgetCaps
  exceeded: boolean
  /** Honest coverage: missing provider telemetry is never presented as measured zero usage. */
  tasksReported?: number
  tasksTotal?: number
  tokenDataComplete?: boolean
  costDataComplete?: boolean
  exceededBy?: Array<'tokens' | 'cost'>
}

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
  permission?: PermissionRequest
  actions: RemoteCommandId[]
}

export interface DeviceInfo {
  id: string
  name: string
  capabilities: RemoteCapability[]
  actor: RemoteActor
  scopes: RemoteScope[]
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
  /** Optional Cloudflare Access identity layer; both values are encrypted via safeStorage. */
  accessTeamDomain?: string
  accessAudience?: string
}

export interface RemotePairStartRequest {
  capabilities?: RemoteCapability[]
  deviceNameHint?: string
  actor?: RemoteActor
  scopes?: RemoteScope[]
}

/** APNs delivery environment; sandbox tokens only reach the sandbox host. */
export type ApnsEnvironment = 'sandbox' | 'production'

/** Native-client registration payload for `POST /push/apns` (no IPC involved). */
export interface ApnsRegisterRequest {
  token: string
  environment: ApnsEnvironment
  bundleId: string
}

/** Desktop-only IPC payload to store APNs signing credentials (encrypted at rest). */
export interface ApnsConfigInput {
  teamId: string
  keyId: string
  /** PEM-encoded `.p8` private key. Never returned back over IPC. */
  p8: string
  bundleId: string
  environment: ApnsEnvironment
}

/** Non-secret APNs configuration status for the desktop UI. Never includes the `.p8`. */
export interface ApnsConfigStatus {
  configured: boolean
  teamId?: string
  keyId?: string
  bundleId?: string
  environment?: ApnsEnvironment
}

function approvalScope(snapshot: OrchestratorSnapshot): { profileId: string; workspaceSessionId: string } | undefined {
  if (!snapshot.profileId || !snapshot.workspaceSessionId) return undefined
  return { profileId: snapshot.profileId, workspaceSessionId: snapshot.workspaceSessionId }
}

/** Shared, node-free approval projection used by desktop and the authenticated remote read model. */
export function deriveRemoteApprovals(snapshots: Iterable<OrchestratorSnapshot>): ApprovalItem[] {
  const approvals: ApprovalItem[] = []
  for (const snapshot of snapshots) {
    const scope = approvalScope(snapshot)
    if (!scope) continue
    for (const pending of snapshot.pendingApprovals ?? []) approvals.push(pending)
    for (const permission of snapshot.pendingPermissions ?? []) {
      approvals.push({
        id: `permission:${permission.id}`,
        kind: 'tool-permission',
        ...scope,
        title: `${permission.provider}: ${permission.tool}`,
        summary: permission.summary,
        createdAt: permission.createdAt,
        permission,
        actions: ['permission.allow', 'permission.deny']
      })
    }
    if (snapshot.pendingPlan) {
      approvals.push({
        id: `plan:${scope.workspaceSessionId}:${snapshot.pendingPlan.planId}`,
        kind: 'plan-review',
        ...scope,
        title: 'Plan wartet auf Freigabe',
        summary: `${snapshot.pendingPlan.plan.tasks.length} Aufgabe(n) · ${snapshot.pendingPlan.plan.goal}`,
        createdAt: snapshot.activity?.updatedAt ?? Date.now(),
        plan: snapshot.pendingPlan,
        actions: ['plan.approve', 'plan.reject']
      })
    }
    if (snapshot.budget?.exceeded) {
      const exceeded = snapshot.budget.exceededBy?.join(' und ') || 'Budget'
      approvals.push({
        id: `budget:${scope.workspaceSessionId}`,
        kind: 'budget-exceeded',
        ...scope,
        title: 'Lauf wegen Budget pausiert',
        summary: `${exceeded} erreicht · ${snapshot.budget.tokens} Token · $${snapshot.budget.costUsd.toFixed(2)}`,
        createdAt: snapshot.activity?.updatedAt ?? Date.now(),
        actions: ['budget.setCaps']
      })
    }
    for (const task of snapshot.tasks) {
      if (task.status !== 'needs-work' && task.status !== 'error') continue
      const limit = /(?:usage|rate|nutzungs|wochen|5.?stunden)[\s-]*(?:limit|quota)|quota/i.test(
        [task.note, task.judgeReason, task.blocker?.summary].filter(Boolean).join(' ')
      )
      if (limit) {
        approvals.push({
          id: `limit:${scope.workspaceSessionId}:${task.id}`,
          kind: 'provider-limit',
          ...scope,
          title: `${task.title}: Provider-Limit`,
          summary: task.note ?? task.judgeReason ?? 'Provider-Limit erkannt.',
          createdAt: task.finishedAt ?? task.createdAt,
          task,
          actions: ['task.fallback', 'run.reset']
        })
        continue
      }
      if (!task.blocker && !task.recoveryArtifact) continue
      approvals.push({
        id: `task:${scope.workspaceSessionId}:${task.id}`,
        kind: 'task-blocked',
        ...scope,
        title: task.title,
        summary: task.blocker?.summary ?? task.note ?? 'Aufgabe benötigt eine Entscheidung.',
        createdAt: task.finishedAt ?? task.createdAt,
        task,
        actions: ['mode.enableAuto', 'run.reset']
      })
    }
  }
  return approvals.sort((a, b) => a.createdAt - b.createdAt)
}
