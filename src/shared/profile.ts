/**
 * Workspace profile schema (zod) shared across processes.
 * A profile describes which agents to open, who orchestrates whom, and Yolo settings.
 */
import { z } from 'zod'

export const agentProviderId = z.enum(['claude', 'codex', 'cursor', 'ollama'])

export const agentSlotSchema = z.object({
  /** Logical role, e.g. "worker", "reviewer". */
  role: z.string().min(1).default('worker'),
  provider: agentProviderId,
  /** Model name (free-text, per provider). Empty = the CLI's own default. */
  model: z.string().default(''),
  /** Number of instances to open for this slot. */
  count: z.number().int().min(1).max(16).default(1),
  /** May the orchestrator dispatch tasks to this slot? */
  orchestrated: z.boolean().default(true),
  /** Run without approval prompts (see Yolo Mode). */
  yolo: z.boolean().default(false),
  /** Optional per-slot working directory override. */
  workingDir: z.string().optional()
})

export const orchestratorSchema = z.object({
  provider: agentProviderId.default('claude'),
  model: z.string().min(1).default('fable'),
  /** Orchestrator may open sub-windows on demand. */
  autoOpenSubwindows: z.boolean().default(true)
})

export const workspaceProfileSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  /** Default working directory (usually a git repo). */
  workingDir: z.string().default(''),
  /** Optional — a workspace can run without an orchestrator. */
  orchestrator: orchestratorSchema.optional(),
  agents: z.array(agentSlotSchema).default([]),
  /** Global Yolo master switch (default OFF for safety). */
  yoloDefault: z.boolean().default(false)
})

export type AgentSlot = z.infer<typeof agentSlotSchema>
export type OrchestratorConfig = z.infer<typeof orchestratorSchema>
export type WorkspaceProfile = z.infer<typeof workspaceProfileSchema>

/**
 * The user's canonical example: a Claude/Fable orchestrator delegating to codex
 * subagents. The subagent model is left blank so codex uses its own configured
 * default (~/.codex/config.toml) — hard-coding a name like "gpt-5.6" 400s on a
 * ChatGPT account. Set the model explicitly in the Profile-Editor if needed.
 */
export const DEFAULT_PROFILE: WorkspaceProfile = {
  id: 'default',
  name: 'Fable + Codex subagents',
  workingDir: '',
  orchestrator: { provider: 'claude', model: 'fable', autoOpenSubwindows: true },
  agents: [
    { role: 'codex', provider: 'codex', model: '', count: 3, orchestrated: true, yolo: false }
  ],
  yoloDefault: false
}
