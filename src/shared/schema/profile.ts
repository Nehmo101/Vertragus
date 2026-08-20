/**
 * Profiles — what a Play button starts.
 *
 * A profile is a repo plus one orchestrator plus a set of SLOTS. A slot is a
 * blueprint ("a reviewer runs on codex/gpt-5.6-sol, at most two of them"), not
 * a fixed number of pre-started windows: the orchestrator decides how many
 * instances it actually needs, bounded by `slot.maxCount` and the profile-wide
 * `maxSubagents`. That is the whole point of the rework — the old repo
 * pre-started a fixed team and then had nothing to say about it.
 *
 * Pure data + zod (no Node imports); main, preload and renderer share it.
 */
import { z } from 'zod'
import { effortLevelSchema } from './provider'
import { zoneLayoutSchema } from './zones'

/** Upper bounds. High enough to never be in the way, low enough to be a bug net. */
export const MAX_SLOTS = 16
export const MAX_SLOT_COUNT = 16
export const MAX_SUBAGENTS = 32

const idSchema = z.string().trim().min(1).max(64)

export const roleTemplateSchema = z
  .object({
    /** Stable role key; also the colour key and the `start_agent{role}` value. */
    id: idSchema,
    name: z.string().trim().min(1).max(40),
    /** The role's system prompt. The task contract is appended separately. */
    prompt: z.string().trim().min(1).max(8000),
    /** True for the five shipped templates; those are not user-deletable. */
    builtin: z.boolean().default(false)
  })
  .strict()
export type RoleTemplate = z.infer<typeof roleTemplateSchema>

export const slotSchema = z
  .object({
    id: idSchema,
    roleId: idSchema,
    providerId: idSchema,
    /** Empty/absent = the provider CLI's own default model. */
    model: z.string().trim().max(200).optional(),
    effort: effortLevelSchema.optional(),
    /** Max parallel instances of this slot. Absent = only `maxSubagents` binds. */
    maxCount: z.number().int().min(1).max(MAX_SLOT_COUNT).optional()
  })
  .strict()
export type Slot = z.infer<typeof slotSchema>

export const orchestratorConfigSchema = z
  .object({
    providerId: idSchema,
    model: z.string().trim().max(200).optional(),
    effort: effortLevelSchema.optional()
  })
  .strict()
export type OrchestratorConfig = z.infer<typeof orchestratorConfigSchema>

export const profileSchema = z
  .object({
    id: idSchema,
    name: z.string().trim().min(1).max(60),
    /** Absolute path to the repository. Empty until the user picks a folder. */
    repoPath: z.string().max(500).default(''),
    orchestrator: orchestratorConfigSchema,
    slots: z.array(slotSchema).max(MAX_SLOTS).default([]),
    /** Absent = the orchestrator decides freely (still bounded per slot). */
    maxSubagents: z.number().int().min(1).max(MAX_SUBAGENTS).optional(),
    /**
     * Press Enter for the agent after an assignment was typed into its CLI.
     *
     * Default `true`, because "the task sits in the composer and nobody presses
     * Enter" is a dead agent with no error message — the first real run lost a
     * whole team to it. Claude Code swallows a trailing `\r` that arrives in the
     * same paste as the text (it reads as a newline of the pasted block), so the
     * submit is sent separately and slightly later; see `interactiveReady`.
     *
     * `false` is the deliberate opposite: the assignment stays in the input
     * field so a human can redact it before it runs.
     */
    autoSubmitTasks: z.boolean().default(true),
    /**
     * E4: wall-clock budget — the sum of agent-seconds a run may burn before
     * new starts are refused (`budget_warning` fires at 80% and at 100%).
     * Deliberately time, not tokens: the host can measure time truthfully.
     */
    maxRuntimeMin: z.number().int().min(1).max(24 * 60).optional(),
    /**
     * E6: playbooks are GOAL TEMPLATES — one click fills the goal field, the
     * orchestrator still decides the team. Never a pre-started crew.
     */
    playbooks: z
      .array(
        z
          .object({
            name: z.string().trim().min(1).max(60),
            goal: z.string().trim().min(1).max(4_000)
          })
          .strict()
      )
      .max(12)
      .optional(),
    zones: zoneLayoutSchema.optional()
  })
  .strict()
export type Profile = z.infer<typeof profileSchema>
export type ProfileInput = z.input<typeof profileSchema>

/**
 * Validate a raw profile list fail-soft: a single corrupt profile must not cost
 * the user every other one. Duplicate ids keep the first occurrence.
 */
export function parseProfiles(raw: unknown): Profile[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  const profiles: Profile[] = []
  for (const entry of raw) {
    const parsed = profileSchema.safeParse(entry)
    if (!parsed.success || seen.has(parsed.data.id)) continue
    seen.add(parsed.data.id)
    profiles.push(parsed.data)
  }
  return profiles
}

/** Collision-resistant local id. Injectable clock/entropy keeps tests exact. */
export function createLocalId(
  prefix: string,
  now: () => number = Date.now,
  random: () => number = Math.random
): string {
  const stamp = now().toString(36)
  const noise = Math.floor(random() * 36 ** 4)
    .toString(36)
    .padStart(4, '0')
  return `${prefix}-${stamp}${noise}`
}

export interface CreateEmptyProfileInput {
  name?: string
  repoPath?: string
  /** Orchestrator provider; defaults to the claude preset. */
  orchestratorProviderId?: string
  id?: string
}

/** A new, valid, empty profile — no slots yet, orchestrator on Claude Code. */
export function createEmptyProfile(input: CreateEmptyProfileInput = {}): Profile {
  return profileSchema.parse({
    id: input.id ?? createLocalId('profile'),
    name: input.name?.trim() || 'New profile',
    repoPath: input.repoPath ?? '',
    orchestrator: { providerId: input.orchestratorProviderId ?? 'claude' },
    slots: []
  })
}

export interface DuplicateProfileOptions {
  /** Word appended to the copy's name; the UI passes its localized term. */
  copyWord?: string
  id?: string
}

/**
 * Independent copy with a fresh id, a non-colliding name and fresh slot ids.
 * Slot ids are regenerated because zone/limit bookkeeping is keyed by them —
 * two profiles sharing a slot id would fight over the same runtime state.
 */
export function duplicateProfile(
  source: Profile,
  existing: readonly Profile[] = [],
  options: DuplicateProfileOptions = {}
): Profile {
  const copyWord = options.copyWord?.trim() || 'copy'
  const takenIds = new Set([source.id, ...existing.map((profile) => profile.id)])
  let id = options.id ?? createLocalId('profile')
  let idSuffix = 2
  while (takenIds.has(id)) {
    id = `${options.id ?? createLocalId('profile')}-${idSuffix}`
    idSuffix += 1
  }

  const takenNames = new Set(
    [source, ...existing].map((profile) => profile.name.trim().toLowerCase())
  )
  const base = source.name.trim()
  let name = `${base} (${copyWord})`
  let nameSuffix = 2
  while (takenNames.has(name.toLowerCase())) {
    name = `${base} (${copyWord} ${nameSuffix})`
    nameSuffix += 1
  }

  const clone = structuredClone(source)
  return profileSchema.parse({
    ...clone,
    id,
    name,
    slots: clone.slots.map((slot) => ({ ...slot, id: createLocalId('slot') }))
  })
}

export interface SlotLimit {
  /** False when the profile has no slot for this role — `start_agent` must refuse. */
  configured: boolean
  /**
   * Combined instance cap of every slot of this role. `undefined` means one of
   * them left `maxCount` open, i.e. only `maxSubagents` binds.
   */
  max?: number
}

/**
 * Effective instance limit of one role. Returned as a shape, not a number,
 * because "no slot at all" (refuse) and "no explicit cap" (allow) are different
 * answers that a bare `0`/`undefined` would blur — the old repo's limit checks
 * got this wrong and starved agents.
 */
export function slotLimitFor(
  profile: Pick<Profile, 'slots'>,
  roleId: string
): SlotLimit {
  const slots = profile.slots.filter((slot) => slot.roleId === roleId)
  if (slots.length === 0) return { configured: false }
  if (slots.some((slot) => slot.maxCount === undefined)) return { configured: true }
  const max = slots.reduce((sum, slot) => sum + (slot.maxCount ?? 0), 0)
  return { configured: true, max: Math.min(max, MAX_SUBAGENTS) }
}

/** Role ids a profile can actually staff, in slot order, deduplicated. */
export function profileRoleIds(profile: Pick<Profile, 'slots'>): string[] {
  return [...new Set(profile.slots.map((slot) => slot.roleId))]
}
