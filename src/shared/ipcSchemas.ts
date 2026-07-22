/**
 * Boundary schemas for renderer→main IPC payloads whose home modules are
 * deliberately zod-free (agents.ts, ipc.ts, inboxSpeech.ts stay type-only for
 * the preload bundle). Parsed via parseIpcPayload in the main process; the
 * inferred types line up with the existing interfaces they validate.
 */
import { z } from 'zod'
import { agentProviderId } from './profile'
import { claudePermissionModeSchema } from './claudePermissionMode'
import { modelPresetSchema } from './models'

export { agentProviderId as providerIdSchema }

/** GithubRepoBindRequest (shared/ipc.ts). */
export const githubRepoBindRequestSchema = z.object({
  owner: z.string().min(1).max(200),
  repo: z.string().min(1).max(200),
  defaultBranch: z.string().max(512).optional(),
  localPath: z.string().max(4096).optional(),
  clone: z.boolean().optional()
})

/** InboxSpeechSettingsPatch (shared/inboxSpeech.ts) — all-optional write patch. */
export const inboxSpeechSettingsPatchSchema = z.object({
  model: z.string().max(200).optional(),
  language: z.string().max(64).optional(),
  endpointUrl: z.string().max(2048).optional(),
  apiKey: z.string().max(4096).optional()
})

const handoffCommonShape = {
  provider: agentProviderId,
  model: z.string().max(200),
  role: z.string().max(200).optional(),
  yolo: z.boolean().optional(),
  task: z.string().max(20_000).optional(),
  summary: z.string().max(20_000).optional()
}

/** HandoffRequest (shared/agents.ts). */
export const handoffRequestSchema = z.object({
  sourceId: z.string().min(1).max(256),
  ...handoffCommonShape
})

/** BulkHandoffRequest (shared/agents.ts). */
export const bulkHandoffRequestSchema = z.object({
  sourceIds: z.array(z.string().min(1).max(256)).min(1).max(64),
  ...handoffCommonShape
})

/**
 * SpawnAgentRequest (shared/agents.ts) — SHALLOW shape validation only.
 * Provider/model gating, worktree policy and capacity limits stay where they
 * live today (AgentManager); this just retires the trust-the-type boundary.
 */
export const spawnAgentRequestSchema = z.object({
  provider: agentProviderId,
  model: z.string().max(200),
  modelPreset: modelPresetSchema.optional(),
  role: z.string().max(200).optional(),
  kind: z.enum(['orchestrator', 'sub']).optional(),
  solo: z.boolean().optional(),
  yolo: z.boolean().optional(),
  teamRole: z.string().max(200).optional(),
  profileId: z.string().max(256).optional(),
  workspaceSessionId: z.string().max(256).optional(),
  engineId: z.string().max(256).optional(),
  workingDir: z.string().max(4096).optional(),
  isolateWorktree: z.boolean().optional(),
  resumeConversation: z.boolean().optional(),
  permissionMode: claudePermissionModeSchema.optional()
})
