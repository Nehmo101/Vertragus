/**
 * Workspace profile schema (zod) shared across processes.
 * A profile describes which agents to open, who orchestrates whom, and Yolo settings.
 */
import { z } from 'zod'
import { claudePermissionModeSchema } from './claudePermissionMode'
import { modelPresetSchema } from './models'
import { postProcessBranchValidationError } from './gitPostProcessing'

export const agentProviderId = z.enum(['claude', 'kimi', 'codex', 'cursor', 'copilot', 'ollama'])

export const agentSlotSchema = z.object({
  /** Logical role, e.g. "worker", "reviewer". */
  role: z.string().min(1).default('worker'),
  provider: agentProviderId,
  /** Model name (free-text, per provider). Empty = preset or CLI default. */
  model: z.string().default(''),
  /** Performance preset when model is empty. Omitted = legacy CLI default. */
  modelPreset: modelPresetSchema.optional(),
  /** Number of instances to open for this slot. */
  count: z.number().int().min(1).default(1),
  /** May the orchestrator dispatch tasks to this slot? */
  orchestrated: z.boolean().default(true),
  /** Per-slot Multiagent override. Omitted means inherit the profile setting. */
  multiAgent: z.boolean().optional(),
  /** Run without approval prompts (see Yolo Mode). */
  yolo: z.boolean().default(false),
  /** Optional per-slot working directory override. */
  workingDir: z.string().optional(),
  /** Tasks this worker/model is especially suitable for. */
  strengths: z.array(z.string().min(1)).max(24).default([]),
  /** Tasks the adaptive router should avoid assigning to this worker/model. */
  weaknesses: z.array(z.string().min(1)).max(24).default([])
})

export const orchestratorSchema = z.object({
  provider: agentProviderId.default('claude'),
  /** Empty = preset or CLI default. Non-empty overrides modelPreset. */
  model: z.string().default(''),
  /** Performance preset when model is empty. Omitted = legacy CLI default. */
  modelPreset: modelPresetSchema.optional(),
  /** Claude CLI permission behavior; ignored by other providers. */
  permissionMode: claudePermissionModeSchema.default('default'),
  /** Orchestrator may open sub-windows on demand. */
  autoOpenSubwindows: z.boolean().default(true)
})

export const plannerConfigSchema = z.object({
  mode: z.enum(['auto', 'review', 'manual']).default('review'),
  /** Fixed addresses configured roles; adaptive treats them as a worker pool. */
  routingMode: z.enum(['fixed', 'adaptive']).default('adaptive'),
  maxParallel: z.number().int().min(1).default(6),
  /** Maximum focused re-plan attempts after a failed execution wave. */
  maxRetries: z.number().int().min(0).max(5).default(1)
})

export const benchmarkConfigSchema = z.object({
  /**
   * Auto-Benchmark profile: the orchestrator gives every slot the SAME task,
   * compares the results and stores scored model knowledge (run_benchmark /
   * record_benchmark tools).
   */
  enabled: z.boolean().default(false)
})

/** Competing workers solve the same task; only an orchestrator-approved candidate is integrated. */
export const multiAgentConfigSchema = z.object({
  enabled: z.boolean().default(false),
  /** Stop unfinished alternatives as soon as the orchestrator accepts or rejects a candidate. */
  stopLosers: z.boolean().default(true)
})

export const autoPrConfigSchema = z.object({
  mode: z.enum(['off', 'draft-after-checks', 'ready-after-checks', 'hold-for-approval']).default('off'),
  strategy: z.enum(['aggregate', 'per-task']).default('aggregate'),
  /** Empty = repository default branch. */
  baseBranch: z.string().default(''),
  /** Trusted local shell commands executed inside the integration worktree. */
  qualityGates: z.array(z.string().min(1)).max(12).default(['corepack pnpm typecheck', 'corepack pnpm test', 'corepack pnpm lint']),
  /**
   * Additional path globs (e.g. "spec/fixtures/**") excluded from the
   * Security-Gate SURFACE scan. Documentation paths are excluded by default;
   * leaked-secret patterns always apply to every file.
   */
  securityGateExcludes: z.array(z.string().min(1).max(200)).max(32).default([]),
  labels: z.array(z.string().min(1)).max(20).default([]),
  reviewers: z.array(z.string().min(1)).max(20).default([])
})

export const autoGitConfigSchema = z.object({
  /** Commit and push only after the complete workspace run succeeded. */
  enabled: z.boolean().default(false),
  /** Explicit origin branch. Empty is allowed only while the feature is disabled. */
  targetBranch: z.string().max(200).default('')
}).superRefine((value, context) => {
  const message = postProcessBranchValidationError(value.targetBranch, value.enabled)
  if (message) context.addIssue({ code: z.ZodIssueCode.custom, path: ['targetBranch'], message })
})

export const githubProjectSchema = z.object({
  owner: z.string().min(1),
  number: z.number().int().positive(),
  title: z.string().min(1),
  url: z.string().url()
})

/** Local clone / remote binding state for the workspace repository. */
export const profileCloneStatusSchema = z.enum([
  'unbound',
  'linked',
  'cloned',
  'diverged',
  'error'
])

/**
 * Structured GitHub repository binding for a workspace profile.
 * Backward compatible: older profiles omit this block and rely on workingDir alone.
 */
export const profileGithubRepoSchema = z.object({
  owner: z.string().min(1),
  repo: z.string().min(1),
  /** Empty = resolve from GitHub when binding or at Auto-PR time. */
  defaultBranch: z.string().default(''),
  /** Local checkout path; empty falls back to profile.workingDir. */
  localPath: z.string().default(''),
  cloneStatus: profileCloneStatusSchema.default('unbound')
})

export const workspaceProfileSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  /** Default working directory (usually a git repo). */
  workingDir: z.string().default(''),
  /** Optional structured GitHub repository binding (owner/repo/branch/local clone). */
  githubRepo: profileGithubRepoSchema.optional(),
  /** Optional GitHub Projects board associated with this workspace. */
  githubProject: githubProjectSchema.optional(),
  /** Optional — a workspace can run without an orchestrator. */
  orchestrator: orchestratorSchema.optional(),
  agents: z.array(agentSlotSchema).default([]),
  /** Global Yolo master switch (default OFF for safety). */
  yoloDefault: z.boolean().default(false),
  planner: plannerConfigSchema.default({}),
  benchmark: benchmarkConfigSchema.default({}),
  multiAgent: multiAgentConfigSchema.default({}),
  autoPr: autoPrConfigSchema.default({}),
  autoGit: autoGitConfigSchema.default({})
})

export type AgentSlot = z.infer<typeof agentSlotSchema>
type ParsedOrchestratorConfig = z.infer<typeof orchestratorSchema>
/** Legacy in-memory profile drafts may not have passed through the schema yet. */
export type OrchestratorConfig = Omit<ParsedOrchestratorConfig, 'permissionMode'> & {
  permissionMode?: ParsedOrchestratorConfig['permissionMode']
}
export type PlannerConfig = z.infer<typeof plannerConfigSchema>
export type BenchmarkConfig = z.infer<typeof benchmarkConfigSchema>
export type MultiAgentConfig = z.infer<typeof multiAgentConfigSchema>
export type AutoPrConfig = z.infer<typeof autoPrConfigSchema>
export type AutoGitConfig = z.infer<typeof autoGitConfigSchema>
export type GithubProjectConfig = z.infer<typeof githubProjectSchema>
export type ProfileCloneStatus = z.infer<typeof profileCloneStatusSchema>
export type ProfileGithubRepo = z.infer<typeof profileGithubRepoSchema>
type ParsedWorkspaceProfile = z.infer<typeof workspaceProfileSchema>
export type WorkspaceProfile = Omit<ParsedWorkspaceProfile, 'orchestrator'> & {
  orchestrator?: OrchestratorConfig
}

/** Create an independent, uniquely identified copy of a workspace profile. */
export function duplicateProfile(
  source: WorkspaceProfile,
  existingProfiles: WorkspaceProfile[]
): WorkspaceProfile {
  const existingIds = new Set([source.id, ...existingProfiles.map((profile) => profile.id)])
  const baseId = `profile-${Date.now().toString(36)}`
  let id = baseId
  let idSuffix = 2
  while (existingIds.has(id)) {
    id = `${baseId}-${idSuffix}`
    idSuffix += 1
  }

  const existingNames = new Set(
    existingProfiles.map((profile) => profile.name.trim().toLowerCase())
  )
  const sourceName = source.name.trim()
  let name = `${sourceName} (Kopie)`
  let nameSuffix = 2
  while (existingNames.has(name.trim().toLowerCase())) {
    name = `${sourceName} (Kopie ${nameSuffix})`
    nameSuffix += 1
  }

  const clonedSource = structuredClone(source)
  return workspaceProfileSchema.parse({
    ...clonedSource,
    id,
    name,
    githubRepo: source.githubRepo
      ? { ...source.githubRepo, cloneStatus: 'unbound', localPath: '' }
      : undefined,
    githubProject: source.githubProject ? { ...source.githubProject } : undefined,
    agents: clonedSource.agents.map((slot) => ({ ...slot, yolo: false })),
    yoloDefault: false
  })
}

export interface RepoProfileGenerationRequest {
  workingDir: string
  /** Provider/model that performs the repository analysis. */
  provider: OrchestratorConfig['provider']
  model: string
  modelPreset?: OrchestratorConfig['modelPreset']
}

/** Effective local path for a profile's bound repository. */
export function profileRepoLocalPath(profile: Pick<WorkspaceProfile, 'workingDir' | 'githubRepo'>): string {
  return profile.githubRepo?.localPath?.trim() || profile.workingDir.trim()
}

/** Default branch from explicit Auto-PR override, profile binding, or empty (= resolve later). */
export function profileDefaultBaseBranch(profile: Pick<WorkspaceProfile, 'autoPr' | 'githubRepo'>): string {
  return profile.autoPr.baseBranch.trim() || profile.githubRepo?.defaultBranch?.trim() || ''
}

/**
 * Give every configured slot a stable role key for orchestrator dispatch.
 * Profiles may contain several slots called "worker"; suffixing those keys in
 * one shared helper keeps the prestarted team and the orchestrator in sync.
 */
export function agentSlotsWithRoles(slots: AgentSlot[]): Array<{ slot: AgentSlot; role: string }> {
  const seen = new Map<string, number>()
  return slots.map((slot) => {
    const base = (slot.role?.trim() || slot.provider).toLowerCase()
    const occurrence = seen.get(base) ?? 0
    seen.set(base, occurrence + 1)
    return { slot, role: occurrence === 0 ? base : `${base}-${occurrence + 1}` }
  })
}

export interface AgentSlotCapabilities {
  strengths: string[]
  weaknesses: string[]
}

/**
 * Give the orchestrator useful routing context even for older profiles that do
 * not yet contain explicit strengths/weaknesses. Explicit profile knowledge is
 * always preferred over these conservative provider/model defaults.
 */
export function agentSlotCapabilities(slot: AgentSlot): AgentSlotCapabilities {
  const strengths = slot.strengths ?? []
  const weaknesses = slot.weaknesses ?? []
  if (strengths.length > 0 || weaknesses.length > 0) {
    return { strengths: [...strengths], weaknesses: [...weaknesses] }
  }

  const model = slot.model.toLowerCase()
  if (slot.provider === 'cursor' && model.includes('fast')) {
    return {
      strengths: [
        'schnelle klar abgegrenzte Implementierung',
        'Frontend-Iteration',
        'mechanische Repo-Aenderungen'
      ],
      weaknesses: ['tiefes Architekturdesign', 'abschliessendes Security-Review']
    }
  }
  if (slot.provider === 'claude' && (model.includes('fable') || model.includes('opus'))) {
    return {
      strengths: ['Backend-Architektur', 'komplexe Refactorings', 'lange Kontexte und Abwaegungen'],
      weaknesses: ['kleine mechanische Aenderungen mit engem Zeitbudget']
    }
  }
  if (slot.provider === 'claude') {
    return {
      strengths: ['Architektur', 'Review', 'komplexe Analyse'],
      weaknesses: ['sehr repetitive Massenaenderungen']
    }
  }
  if (slot.provider === 'kimi' && model.includes('thinking')) {
    return {
      strengths: ['tiefes Reasoning', 'mehrstufige Tool-Ketten', 'sehr lange Kontexte'],
      weaknesses: ['kleine mechanische Aenderungen mit engem Zeitbudget']
    }
  }
  if (slot.provider === 'kimi') {
    return {
      strengths: ['agentische Implementierung', 'lange Kontexte', 'werkzeugorientierte Aufgaben'],
      weaknesses: ['rein visuelle Entwurfsarbeit ohne Repo-Kontext']
    }
  }
  if (slot.provider === 'codex') {
    return {
      strengths: ['repo-nahe Implementierung', 'Tests und Debugging', 'praezise Code-Reviews'],
      weaknesses: ['rein visuelle Entwurfsarbeit ohne Repo-Kontext']
    }
  }
  if (slot.provider === 'copilot') {
    return {
      strengths: ['gezielte Implementierung', 'GitHub-nahe Aufgaben', 'Code-Ergaenzungen'],
      weaknesses: ['grosse autonome Architekturumbauten']
    }
  }
  return {
    strengths: ['lokale kostenguenstige Aufgaben', 'offlinefaehige Analyse'],
    weaknesses: ['sehr grosse Kontexte', 'providerabhaengige Tool-Integrationen']
  }
}

/**
 * A balanced Claude orchestrator delegating to Codex subagents. The Claude
 * preset resolves to the stable `sonnet` alias; Codex stays empty so its own
 * configured CLI default is used unless the user explicitly selects a model.
 */
export const DEFAULT_PROFILE: WorkspaceProfile = {
  id: 'default',
  name: 'Claude + Codex subagents',
  workingDir: '',
  orchestrator: {
    provider: 'claude',
    model: '',
    modelPreset: 'balanced',
    permissionMode: 'default',
    autoOpenSubwindows: true
  },
  agents: [
    {
      role: 'codex',
      provider: 'codex',
      model: '',
      count: 3,
      orchestrated: true,
      yolo: false,
      strengths: [],
      weaknesses: []
    }
  ],
  yoloDefault: false,
  planner: { mode: 'review', routingMode: 'adaptive', maxParallel: 6, maxRetries: 1 },
  benchmark: { enabled: false },
  multiAgent: { enabled: false, stopLosers: true },
  autoPr: {
    mode: 'off',
    strategy: 'aggregate',
    baseBranch: '',
    qualityGates: ['corepack pnpm typecheck', 'corepack pnpm test', 'corepack pnpm lint'],
    securityGateExcludes: [],
    labels: [],
    reviewers: []
  },
  autoGit: { enabled: false, targetBranch: '' }
}
