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
import { initialRolePromptEntries } from '../prompts/rolePrompt'

/** Upper bounds. High enough to never be in the way, low enough to be a bug net. */
export const MAX_SLOTS = 16
export const MAX_SLOT_COUNT = 16
export const MAX_SUBAGENTS = 32
export const ROLE_PROMPT_MAX_CHARS = 8000

const idSchema = z.string().trim().min(1).max(64)

export const roleTemplateSchema = z
  .object({
    /** Stable role key; also the colour key and the `start_agent{role}` value. */
    id: idSchema,
    name: z.string().trim().min(1).max(40),
    /** The role's system prompt. The task contract is appended separately. */
    prompt: z.string().trim().min(1).max(ROLE_PROMPT_MAX_CHARS),
    /** True for the five shipped templates; those are not user-deletable. */
    builtin: z.boolean().default(false)
  })
  .strict()
export type RoleTemplate = z.infer<typeof roleTemplateSchema>

/** E6: at most this many extra MCP servers per slot — a bug net, not a quota. */
export const MAX_EXTRA_MCP = 4

/**
 * Per-identity extra system prompts in a profile (orchestrator, lead, and
 * every role). High enough for the seven built-ins plus custom roles and the
 * two reserved identities; low enough to be a bug net.
 */
export const MAX_ROLE_PROMPTS = 32

/**
 * How many follow-up questions the root orchestrator asks the user via
 * `ask_user`. Prompt-only: the tool stays registered. Default `few` is
 * today's behaviour (genuine user decisions — scope / destructive / product).
 */
export const QUESTION_MODES = ['none', 'few', 'thorough'] as const
export type QuestionMode = (typeof QUESTION_MODES)[number]
export const questionModeSchema = z.enum(QUESTION_MODES)

export const rolePromptEntrySchema = z
  .object({
    roleId: idSchema,
    prompt: z.string().trim().min(1).max(ROLE_PROMPT_MAX_CHARS)
  })
  .strict()
export type RolePromptEntry = z.infer<typeof rolePromptEntrySchema>

function uniqueRolePromptIds(
  entries: readonly { roleId: string }[],
  ctx: z.RefinementCtx
): void {
  const seen = new Set<string>()
  for (let index = 0; index < entries.length; index += 1) {
    const id = entries[index]!.roleId
    if (seen.has(id)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'duplicate roleId',
        path: [index, 'roleId']
      })
    }
    seen.add(id)
  }
}

/**
 * E6: one extra MCP server a slot's agents attach IN ADDITION to Vertragus.
 * The name must be a TOML/JSON-safe bare key (it becomes a Codex `-c
 * mcp_servers.<name>.url` override and a Grok `[mcp_servers.<name>]` table),
 * and `vertragus` is reserved so nothing can shadow the reporting channel.
 */
export const extraMcpServerSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1)
      .max(40)
      .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/, 'letters, digits, "_" and "-" only')
      .refine((name) => name.toLowerCase() !== 'vertragus', {
        message: 'the name "vertragus" is reserved for the built-in server'
      }),
    /** HTTP(S) Streamable endpoint; every dialect here treats a bare url as HTTP. */
    url: z.string().trim().url().max(500)
  })
  .strict()
export type ExtraMcpServer = z.infer<typeof extraMcpServerSchema>

/** The remote an auto-PR pushes to unless the profile names another one. */
export const DEFAULT_PR_REMOTE = 'origin'

/**
 * A3: what the host does at the end of a piece of work WITHOUT a human click.
 *
 * Everything here is off by default. Vertragus' doctrine is that adopting an
 * agent's work is the user's decision — these switches are that decision, made
 * once in the profile instead of once per branch. What they never become is a
 * second merge path: auto-adoption runs through exactly the host merges the
 * panel button and `integrate_branch` already use, and a conflict aborts and
 * reports there just the same.
 */
export const automationSchema = z
  .object({
    /**
     * Merge every cleanly reported agent branch into the ORCHESTRATOR's
     * worktree as soon as its `agent_done` lands. Keeps the run's integration
     * branch complete without the orchestrator having to call
     * `integrate_branch` for every worker — and it is the branch `autoPr`
     * opens the pull request from.
     */
    autoIntegrate: z.boolean().default(false),
    /**
     * Merge every cleanly reported agent branch into the REPOSITORY's own
     * checkout — the panel's Promote button, without the click. This is the
     * "merge the branch in the panel to get the fix" step automated; a dirty
     * checkout still refuses (never overwrite the user's own work).
     */
    autoPromote: z.boolean().default(false),
    /**
     * Open a pull request when the run wraps up (`record_retro`, or the user
     * stopping the workspace). Pushes the run's branch first; needs the GitHub
     * CLI (`gh`) to be installed and logged in — without it the host reports
     * the ready-made compare URL instead of failing the run.
     */
    autoPr: z.boolean().default(false),
    /** Remote the PR branch is pushed to. */
    prRemote: z.string().trim().min(1).max(100).default(DEFAULT_PR_REMOTE),
    /** PR base; absent = the branch the repository checkout is on. */
    prBaseBranch: z.string().trim().max(300).optional(),
    /** Open the pull request as a draft. */
    prDraft: z.boolean().default(false)
  })
  .strict()
export type ProfileAutomation = z.infer<typeof automationSchema>

/** Every switch off — what a profile without an `automation` block means. */
export const AUTOMATION_OFF: ProfileAutomation = automationSchema.parse({})

export const slotSchema = z
  .object({
    id: idSchema,
    roleId: idSchema,
    providerId: idSchema,
    /** Empty/absent = the provider CLI's own default model. */
    model: z.string().trim().max(200).optional(),
    effort: effortLevelSchema.optional(),
    /** Max parallel instances of this slot. Absent = only `maxSubagents` binds. */
    maxCount: z.number().int().min(1).max(MAX_SLOT_COUNT).optional(),
    /**
     * E6: extra MCP servers for this slot's agents — SUBAGENTS ONLY. The
     * orchestrator and leads never get them: their tool surface is the
     * allow-list, and a browser tool on the delegator is how a delegator
     * starts doing the work itself.
     */
    extraMcp: z.array(extraMcpServerSchema).max(MAX_EXTRA_MCP).optional()
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
     * How often the root orchestrator calls `ask_user`. Prompt-only — the
     * tool stays registered. Default `few` so old profiles (and every new
     * one) keep today's behaviour: genuine user decisions only, no intake.
     */
    questionMode: questionModeSchema.default('few'),
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
    /**
     * A3: end-of-work automation (auto-integrate, auto-promote, auto-PR).
     * Absent in every profile written before A3 — the default is every switch
     * off, so an old profile keeps needing the human click it always needed.
     */
    automation: automationSchema.default(() => automationSchema.parse({})),
    zones: zoneLayoutSchema.optional(),
    /**
     * Per-identity extra system prompt, written in the profile editor.
     * Keyed by role id (`worker`, `tester`, …) plus the reserved keys
     * `orchestrator` and `lead`. Appended after the host-generated / shipped
     * role prompt so a user cannot erase the loop or the reporting contract.
     * Absent in every profile written before this field — empty means the
     * shipped prompt only.
     */
    rolePrompts: z
      .array(rolePromptEntrySchema)
      .max(MAX_ROLE_PROMPTS)
      .superRefine(uniqueRolePromptIds)
      .optional()
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

/** A new, valid profile — no slots yet, orchestrator on Claude Code, starter extras. */
export function createEmptyProfile(input: CreateEmptyProfileInput = {}): Profile {
  return profileSchema.parse({
    id: input.id ?? createLocalId('profile'),
    name: input.name?.trim() || 'New profile',
    repoPath: input.repoPath ?? '',
    orchestrator: { providerId: input.orchestratorProviderId ?? 'claude' },
    slots: [],
    rolePrompts: initialRolePromptEntries()
  })
}

export interface DuplicateProfileOptions {
  /** Word appended to the copy's name; the UI passes its localized term. */
  copyWord?: string
  id?: string
  /**
   * Keep the source name when nothing already uses it. Duplicate-in-place still
   * suffixes (the source itself occupies the name); import uses this so a
   * unique "UWE" stays "UWE" instead of becoming "UWE (imported)".
   */
  keepName?: boolean
  /**
   * Drop the zone layout. Portable copies must not carry screen geometry —
   * displays and work areas belong to one machine.
   */
  omitZones?: boolean
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
    (options.keepName ? existing : [source, ...existing]).map((profile) =>
      profile.name.trim().toLowerCase()
    )
  )
  const base = source.name.trim()
  let name = options.keepName && !takenNames.has(base.toLowerCase()) ? base : `${base} (${copyWord})`
  let nameSuffix = 2
  while (takenNames.has(name.toLowerCase())) {
    name = `${base} (${copyWord} ${nameSuffix})`
    nameSuffix += 1
  }

  const clone = structuredClone(source)
  if (options.omitZones) delete clone.zones
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

/**
 * The extra system prompt the user stored for one identity, or `undefined`
 * when the profile has none. Empty/whitespace values are treated as absent.
 */
export function rolePromptFor(
  profile: Pick<Profile, 'rolePrompts'> | undefined,
  roleId: string
): string | undefined {
  const text = profile?.rolePrompts?.find((entry) => entry.roleId === roleId)?.prompt.trim()
  return text ? text : undefined
}
