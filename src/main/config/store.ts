/**
 * Persistent config store (electron-store). Holds workspace profiles and app settings.
 * Secrets (e.g. Cloudflare token) will be encrypted via Electron safeStorage in Phase 3.
 */
import Store from 'electron-store'
import { copyFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DEFAULT_PROFILE, workspaceProfileSchema, type WorkspaceProfile } from '@shared/profile'
import { mcpServerSchema, mcpServersSchema, type McpServerConfig } from '@shared/mcp'
import { CURRENT_CONFIG_SCHEMA_VERSION, migrateConfigSnapshot } from '@main/config/migrations'

interface OrcaConfigShape {
  schemaVersion: number
  profiles: WorkspaceProfile[]
  activeProfileId: string
  settings: Record<string, unknown>
}

const store = new Store<OrcaConfigShape>({
  name: 'orca-strator',
  defaults: {
    schemaVersion: 0,
    profiles: [DEFAULT_PROFILE],
    activeProfileId: DEFAULT_PROFILE.id,
    settings: {}
  }
})

function migrateStore(): void {
  const previousVersion = store.get('schemaVersion') ?? 0
  if (previousVersion >= CURRENT_CONFIG_SCHEMA_VERSION) return

  if (existsSync(store.path)) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    copyFileSync(
      store.path,
      join(dirname(store.path), `orca-strator.pre-v${CURRENT_CONFIG_SCHEMA_VERSION}.${stamp}.json`)
    )
  }
  const migrated = migrateConfigSnapshot({
    schemaVersion: previousVersion,
    profiles: store.get('profiles'),
    activeProfileId: store.get('activeProfileId'),
    settings: store.get('settings')
  })
  store.set('profiles', migrated.profiles)
  store.set('activeProfileId', migrated.activeProfileId)
  store.set('settings', migrated.settings)
  store.set('schemaVersion', migrated.schemaVersion)
}

migrateStore()

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
  const parsed = store.get('profiles').map((profile) => workspaceProfileSchema.parse(profile))
  // Persist schema defaults so older installations migrate once and every
  // process observes the same complete profile shape.
  store.set('profiles', parsed)
  return parsed
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

export function deleteProfile(id: string): WorkspaceProfile[] {
  let profiles = store.get('profiles').filter((p) => p.id !== id)
  if (profiles.length === 0) profiles = [DEFAULT_PROFILE]
  store.set('profiles', profiles)
  if (store.get('activeProfileId') === id) store.set('activeProfileId', profiles[0].id)
  return profiles
}

export function getProfile(id: string): WorkspaceProfile | undefined {
  return listProfiles().find((p) => p.id === id)
}

export function getActiveProfileId(): string {
  return store.get('activeProfileId')
}

export function setActiveProfileId(id: string): void {
  store.set('activeProfileId', id)
}

/**
 * User-configured external MCP servers (persisted under the `mcpServers`
 * settings key). Invalid entries are dropped so a corrupt store never breaks
 * agent launches.
 */
export function listMcpServers(): McpServerConfig[] {
  const raw = getSetting<unknown[]>('mcpServers')
  if (!Array.isArray(raw)) return []
  const servers: McpServerConfig[] = []
  for (const entry of raw) {
    const parsed = mcpServerSchema.safeParse(entry)
    if (parsed.success) servers.push(parsed.data)
  }
  return servers
}

/** Validate + persist the full MCP server list, returning the stored result. */
export function saveMcpServers(servers: McpServerConfig[]): McpServerConfig[] {
  const parsed = mcpServersSchema.parse(servers)
  setSetting('mcpServers', parsed)
  return parsed
}
