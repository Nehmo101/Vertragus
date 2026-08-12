/**
 * Retro schema — what a workspace run leaves behind.
 *
 * A RunRetro is written automatically when a workspace stops: per role+model
 * tallies folded from the event stream, plus the summary the orchestrator gave
 * via `record_retro` (empty when it never called the tool — the stats exist
 * either way). ModelLearnings are the qualitative half: short insights keyed by
 * provider+model, reinforced (`observations`) instead of duplicated, and fed
 * back into the next orchestrator prompt.
 *
 * Pure data + zod (no Node imports); main, preload and renderer share it.
 */
import { z } from 'zod'

/** Bounded history: newest first, older runs fall off. */
export const MAX_RUN_RETROS = 50
export const MAX_LEARNINGS_PER_MODEL_KIND = 12
export const MAX_LEARNINGS_TOTAL = 400

const idSchema = z.string().trim().min(1).max(64)

export const learningKindSchema = z.enum(['strength', 'weakness'])
export type LearningKind = z.infer<typeof learningKindSchema>

/** 'orchestrator' = recorded via record_retro; 'auto' = derived heuristically. */
export const learningSourceSchema = z.enum(['orchestrator', 'auto'])
export type LearningSource = z.infer<typeof learningSourceSchema>

export const modelLearningSchema = z
  .object({
    id: z.string().trim().min(1).max(120),
    providerId: idSchema,
    /** Resolved model name; empty string = the provider CLI's own default. */
    model: z.string().trim().max(200).default(''),
    /** Role the insight was observed in, informational only. */
    roleId: idSchema.optional(),
    kind: learningKindSchema,
    insight: z.string().trim().min(1).max(200),
    evidence: z.string().trim().max(300).optional(),
    source: learningSourceSchema,
    profileId: idSchema.optional(),
    /** How often the same insight was re-confirmed. */
    observations: z.number().int().min(1),
    createdAt: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative()
  })
  .strict()
export type ModelLearning = z.infer<typeof modelLearningSchema>

/** A learning as the recorder hands it in — identity and bookkeeping added on merge. */
export type NewModelLearning = Omit<
  ModelLearning,
  'id' | 'observations' | 'createdAt' | 'updatedAt'
>

const counter = z.number().int().min(0)

export const roleModelStatsSchema = z
  .object({
    roleId: idSchema,
    /** Empty string when the run predates provider identity in agent_started. */
    providerId: z.string().trim().max(64).default(''),
    model: z.string().trim().max(200).default(''),
    started: counter,
    /** agent_done outcomes, judged by the orchestrator. */
    succeeded: counter,
    blocked: counter,
    failed: counter,
    /** agent_exited with confirmed: false — process died without reporting. */
    unconfirmedExits: counter,
    stopped: counter
  })
  .strict()
export type RoleModelStats = z.infer<typeof roleModelStatsSchema>

export const runRetroSchema = z
  .object({
    id: idSchema,
    workspaceId: idSchema,
    workspaceName: z.string().trim().min(1).max(120),
    profileId: idSchema,
    /** Orchestrator's record_retro verdict; empty when it never called the tool. */
    summary: z.string().trim().max(2000).default(''),
    stats: z.array(roleModelStatsSchema),
    createdAt: z.number().int().nonnegative(),
    endedAt: z.number().int().nonnegative()
  })
  .strict()
export type RunRetro = z.infer<typeof runRetroSchema>

/**
 * Validate a raw retro list fail-soft: one corrupt row must not cost the user
 * the rest of the history. Duplicate ids keep the first occurrence.
 */
export function parseRunRetros(raw: unknown): RunRetro[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  const retros: RunRetro[] = []
  for (const entry of raw) {
    const parsed = runRetroSchema.safeParse(entry)
    if (!parsed.success || seen.has(parsed.data.id)) continue
    seen.add(parsed.data.id)
    retros.push(parsed.data)
  }
  return retros
}

/** Same fail-soft rule for the learning store. */
export function parseModelLearnings(raw: unknown): ModelLearning[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  const learnings: ModelLearning[] = []
  for (const entry of raw) {
    const parsed = modelLearningSchema.safeParse(entry)
    if (!parsed.success || seen.has(parsed.data.id)) continue
    seen.add(parsed.data.id)
    learnings.push(parsed.data)
  }
  return learnings
}
