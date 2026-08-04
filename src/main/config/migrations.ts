import { DEFAULT_PROFILE, workspaceProfileSchema, type WorkspaceProfile } from '@shared/profile'
import type { AgentProviderId } from '@shared/providers'

export const CURRENT_CONFIG_SCHEMA_VERSION = 5

export interface MigratedConfig {
  schemaVersion: number
  profiles: WorkspaceProfile[]
  activeProfileId: string
  settings: Record<string, unknown>
}

function recordOrEmpty(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>) }
    : {}
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

/**
 * The model ids the retired fast/balanced/strong tier presets expanded to,
 * frozen here as migration data. They must NOT come from a live table any more:
 * the presets are gone, and a migration has to reproduce what the old install
 * actually ran, not what a current table would say.
 */
const LEGACY_PRESET_MODELS: Record<AgentProviderId, Record<string, string>> = {
  claude: { fast: 'haiku', balanced: 'sonnet', strong: 'opus' },
  kimi: { fast: 'kimi-k3-turbo', balanced: 'kimi-k3', strong: 'kimi-k3-thinking' },
  codex: { fast: 'gpt-5.4-mini', balanced: 'gpt-5.6-terra', strong: 'gpt-5.6-sol' },
  cursor: { fast: 'composer-2.5-fast', balanced: 'composer-2.5', strong: 'claude-opus-4-8-high' },
  copilot: { fast: 'claude-haiku-4.5', balanced: 'claude-sonnet-4.6', strong: 'gpt-5.4' },
  ollama: { fast: 'qwen2.5-coder:14b', balanced: 'qwen2.5-coder:32b', strong: 'llama3.3:70b' }
}

/** Effort level a legacy tier preset best corresponds to. */
const LEGACY_PRESET_EFFORT: Record<string, string> = {
  fast: 'low',
  balanced: 'medium',
  strong: 'high'
}

function legacyPresetModel(provider: unknown, preset: string): string | undefined {
  const table = LEGACY_PRESET_MODELS[provider as AgentProviderId]
  return table?.[preset]
}

/**
 * v4: fold the retired model-tier preset into the fields that replaced it.
 *
 * `modelPreset` only ever expanded to a model id, so an install that ran
 * "balanced" on Claude was running `sonnet`. The migration writes that alias
 * into `model` (aliases keep tracking the newest release of the family, which is
 * the whole point) and carries the tier's rough intent over to the new `effort`
 * knob. An explicitly chosen model always wins — it did before, too.
 *
 * Runs on the RAW snapshot: the schema no longer knows `modelPreset`, so a parse
 * would strip the value before it could be read.
 */
function adoptLegacyModelPreset(raw: Record<string, unknown>): Record<string, unknown> {
  const preset = typeof raw.modelPreset === 'string' ? raw.modelPreset : undefined
  if (!preset) return raw
  const rest = { ...raw }
  delete rest.modelPreset
  const model = typeof rest.model === 'string' ? rest.model.trim() : ''
  const adopted = model || legacyPresetModel(rest.provider, preset) || ''
  return {
    ...rest,
    model: adopted,
    effort: typeof rest.effort === 'string' ? rest.effort : LEGACY_PRESET_EFFORT[preset]
  }
}

/**
 * v2 (kept, now raw-level): drop the accidental Fable override that shipped
 * alongside the balanced preset, so the preset adoption above can put the
 * balanced alias in its place. Only the stock profile and the exact
 * contradictory generated value are touched; an intentional standalone
 * `model: "fable"` selection remains.
 */
function resetGeneratedClaudeModel(raw: Record<string, unknown>): Record<string, unknown> {
  const orchestrator = isRecord(raw.orchestrator) ? raw.orchestrator : undefined
  if (!orchestrator || orchestrator.provider !== 'claude' || orchestrator.model !== 'fable') {
    return raw
  }

  const isStockDefault =
    raw.id === 'default' &&
    raw.name === 'Fable + Codex subagents' &&
    orchestrator.modelPreset === undefined
  const isGeneratedPresetConflict = orchestrator.modelPreset === 'balanced'
  if (!isStockDefault && !isGeneratedPresetConflict) return raw

  return {
    ...raw,
    name: isStockDefault ? DEFAULT_PROFILE.name : raw.name,
    orchestrator: { ...orchestrator, model: '', modelPreset: 'balanced' }
  }
}

/**
 * v5: Yolo is the new default (Safe Mode is the opt-out). A profile is flipped
 * ONLY when its entire yolo configuration still carries the old stock default —
 * `yoloDefault: false` AND every slot `yolo: false`. Any `true` anywhere means
 * the user configured yolo deliberately; such profiles are left untouched, and
 * so is any profile where the user turned individual slots off (mixed states
 * cannot exist under the old all-false stock default without deliberate edits).
 *
 * Runs on the RAW snapshot because `store.ts:listProfiles` has been persisting
 * parsed schema defaults back to disk — every existing install stores EXPLICIT
 * `false` values, so the flipped schema default alone would never reach them.
 */
function flipStockYoloDefaults(raw: Record<string, unknown>): Record<string, unknown> {
  const slots = Array.isArray(raw.agents) ? raw.agents : []
  const yoloDefault = raw.yoloDefault === undefined ? false : raw.yoloDefault
  const allStockOff =
    yoloDefault === false &&
    slots.every((slot) => !isRecord(slot) || slot.yolo === undefined || slot.yolo === false)
  if (!allStockOff) return raw
  return {
    ...raw,
    yoloDefault: true,
    agents: slots.map((slot) => (isRecord(slot) ? { ...slot, yolo: true } : slot))
  }
}

/** Raw-level rewrites applied before the profile schema sees the snapshot. */
function migrateRawProfile(value: unknown): unknown {
  if (!isRecord(value)) return value
  const profile = flipStockYoloDefaults(resetGeneratedClaudeModel(value))
  const orchestrator = isRecord(profile.orchestrator)
    ? adoptLegacyModelPreset(profile.orchestrator)
    : profile.orchestrator
  const agents = Array.isArray(profile.agents)
    ? profile.agents.map((slot) => (isRecord(slot) ? adoptLegacyModelPreset(slot) : slot))
    : profile.agents
  return { ...profile, orchestrator, agents }
}

export function migrateConfigSnapshot(raw: unknown): MigratedConfig {
  const source = recordOrEmpty(raw)
  const profiles = Array.isArray(source.profiles)
    ? source.profiles.flatMap((profile) => {
        const parsed = workspaceProfileSchema.safeParse(migrateRawProfile(profile))
        return parsed.success ? [parsed.data] : []
      })
    : []
  const safeProfiles = profiles.length > 0 ? profiles : [DEFAULT_PROFILE]
  const requestedActive = typeof source.activeProfileId === 'string' ? source.activeProfileId : ''
  const activeProfileId = safeProfiles.some((profile) => profile.id === requestedActive)
    ? requestedActive
    : safeProfiles[0].id

  // v5: yolo is default-ON. An install that never touched the master switch has
  // no stored value — give it the new default explicitly. A deliberate stored
  // `false` (the user turned yolo off) is preserved.
  const settings = recordOrEmpty(source.settings)
  if (settings.yoloMaster === undefined) settings.yoloMaster = true

  return {
    schemaVersion: CURRENT_CONFIG_SCHEMA_VERSION,
    profiles: safeProfiles,
    activeProfileId,
    settings
  }
}
