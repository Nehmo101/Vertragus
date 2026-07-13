import { DEFAULT_PROFILE, workspaceProfileSchema, type WorkspaceProfile } from '@shared/profile'

export const CURRENT_CONFIG_SCHEMA_VERSION = 2

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

/**
 * v2 removes the accidental Fable override that shipped alongside the balanced
 * preset. Only the stock profile and the exact contradictory generated value
 * are touched; intentional standalone `model: "fable"` selections remain.
 */
function resetGeneratedClaudeModel(profile: WorkspaceProfile): WorkspaceProfile {
  const orchestrator = profile.orchestrator
  if (!orchestrator || orchestrator.provider !== 'claude' || orchestrator.model !== 'fable') {
    return profile
  }

  const isStockDefault =
    profile.id === 'default' &&
    profile.name === 'Fable + Codex subagents' &&
    orchestrator.modelPreset === undefined
  const isGeneratedPresetConflict = orchestrator.modelPreset === 'balanced'
  if (!isStockDefault && !isGeneratedPresetConflict) return profile

  return {
    ...profile,
    name: isStockDefault ? DEFAULT_PROFILE.name : profile.name,
    orchestrator: { ...orchestrator, model: '', modelPreset: 'balanced' }
  }
}

export function migrateConfigSnapshot(raw: unknown): MigratedConfig {
  const source = recordOrEmpty(raw)
  const profiles = Array.isArray(source.profiles)
    ? source.profiles.flatMap((profile) => {
        const parsed = workspaceProfileSchema.safeParse(profile)
        return parsed.success ? [resetGeneratedClaudeModel(parsed.data)] : []
      })
    : []
  const safeProfiles = profiles.length > 0 ? profiles : [DEFAULT_PROFILE]
  const requestedActive = typeof source.activeProfileId === 'string' ? source.activeProfileId : ''
  const activeProfileId = safeProfiles.some((profile) => profile.id === requestedActive)
    ? requestedActive
    : safeProfiles[0].id

  return {
    schemaVersion: CURRENT_CONFIG_SCHEMA_VERSION,
    profiles: safeProfiles,
    activeProfileId,
    settings: recordOrEmpty(source.settings)
  }
}
