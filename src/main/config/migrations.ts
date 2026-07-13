import { DEFAULT_PROFILE, workspaceProfileSchema, type WorkspaceProfile } from '@shared/profile'

export const CURRENT_CONFIG_SCHEMA_VERSION = 1

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

export function migrateConfigSnapshot(raw: unknown): MigratedConfig {
  const source = recordOrEmpty(raw)
  const profiles = Array.isArray(source.profiles)
    ? source.profiles.flatMap((profile) => {
        const parsed = workspaceProfileSchema.safeParse(profile)
        return parsed.success ? [parsed.data] : []
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
