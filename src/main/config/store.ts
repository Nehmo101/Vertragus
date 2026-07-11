/**
 * Persistent config store (electron-store). Holds workspace profiles and app settings.
 * Secrets (e.g. Cloudflare token) will be encrypted via Electron safeStorage in Phase 3.
 */
import Store from 'electron-store'
import { DEFAULT_PROFILE, workspaceProfileSchema, type WorkspaceProfile } from '@shared/profile'

interface OrcaConfigShape {
  profiles: WorkspaceProfile[]
  activeProfileId: string
  settings: Record<string, unknown>
}

const store = new Store<OrcaConfigShape>({
  name: 'orca-strator',
  defaults: {
    profiles: [DEFAULT_PROFILE],
    activeProfileId: DEFAULT_PROFILE.id,
    settings: {}
  }
})

export function getSetting<T = unknown>(key: string): T | undefined {
  const settings = store.get('settings')
  return settings?.[key] as T | undefined
}

export function setSetting(key: string, value: unknown): void {
  const settings = { ...store.get('settings') }
  settings[key] = value
  store.set('settings', settings)
}

export function listProfiles(): WorkspaceProfile[] {
  return store.get('profiles')
}

/** Validate + upsert a profile by id, returning the full updated list. */
export function saveProfile(profile: WorkspaceProfile): WorkspaceProfile[] {
  const parsed = workspaceProfileSchema.parse(profile)
  const profiles = store.get('profiles')
  const idx = profiles.findIndex((p) => p.id === parsed.id)
  if (idx >= 0) profiles[idx] = parsed
  else profiles.push(parsed)
  store.set('profiles', profiles)
  return profiles
}

export function getActiveProfileId(): string {
  return store.get('activeProfileId')
}

export function setActiveProfileId(id: string): void {
  store.set('activeProfileId', id)
}
