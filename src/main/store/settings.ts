/**
 * The persistent store — profiles, provider overrides, custom role templates
 * and app settings.
 *
 * Two rules the previous generation learned the hard way:
 *
 * 1. **Fail-soft on read.** Every read validates and DROPS what does not
 *    validate instead of throwing. A hand-edited or half-written config file
 *    must cost the user the broken row, never the whole list — and never the
 *    app's ability to start.
 * 2. **No migrations.** This is a fresh store (`vertragus.json`, version 1) with
 *    no data to inherit. The old repo's migration chain was a permanent source
 *    of "why is my profile different now"; if v2 ever needs one, it gets one
 *    deliberately, not by accident.
 *
 * The backing store is injectable so every rule above is unit-testable without
 * an Electron runtime — electron-store itself is only constructed lazily, on
 * first real use inside the app.
 */
import Store from 'electron-store'
import { z } from 'zod'
import {
  parseProfiles,
  profileSchema,
  roleTemplateSchema,
  type Profile,
  type RoleTemplate
} from '@shared/schema/profile'
import {
  mergeProviderConfigs,
  modelMemorySchema,
  parseProviderConfigs,
  providerConfigSchema,
  type ProviderConfig
} from '@shared/schema/provider'
import { providerPresets } from '@main/providers/presets'

export const STORE_NAME = 'vertragus'
export const STORE_VERSION = 1

export const panelBoundsSchema = z
  .object({
    edge: z.enum(['left', 'right']),
    /** Vertical offset of the panel on its edge, in screen pixels. */
    y: z.number().finite()
  })
  .strict()
export type PanelBounds = z.infer<typeof panelBoundsSchema>

export const uiSettingsSchema = z
  .object({
    panelBounds: panelBoundsSchema.optional(),
    theme: z.enum(['dark', 'light']).default('dark'),
    locale: z.enum(['de', 'en']).default('de')
  })
  .strict()
export type UiSettings = z.infer<typeof uiSettingsSchema>

export const appSettingsSchema = z
  .object({
    ui: uiSettingsSchema.default({}),
    /** Master switch above every slot's yolo flag. Subagents default to yolo. */
    yoloMaster: z.boolean().default(true),
    /** Electron accelerator; registration failure must be shown, never swallowed. */
    hideAllHotkey: z.string().trim().min(1).max(80).default('Control+Alt+V'),
    autostart: z.boolean().default(false),
    /** `{ providerId: { modelId: lastSeenAtMs } }` — see providers/discovery. */
    modelMemory: modelMemorySchema.default({})
  })
  .strict()
export type AppSettings = z.infer<typeof appSettingsSchema>

/** Keys of the store's top-level sections. */
export const SETTINGS_KEYS = ['ui', 'yoloMaster', 'hideAllHotkey', 'autostart', 'modelMemory'] as const

export interface SettingsBackend {
  get(key: string): unknown
  set(key: string, value: unknown): void
}

export interface SettingsStoreDeps {
  backend: SettingsBackend
  /** Where dropped rows are reported. Injectable so tests can assert on it. */
  warn?: (message: string) => void
}

function defaultSetting<K extends keyof AppSettings>(key: K): AppSettings[K] {
  return appSettingsSchema.parse({})[key]
}

export interface SettingsStore {
  getProfiles(): Profile[]
  getProfile(id: string): Profile | undefined
  saveProfile(profile: unknown): Profile[]
  deleteProfile(id: string): Profile[]
  /** Stored provider entries only — presets are code, see effectiveProviders. */
  getProviders(): ProviderConfig[]
  saveProvider(config: unknown): ProviderConfig[]
  deleteProvider(id: string): ProviderConfig[]
  effectiveProviders(): ProviderConfig[]
  getRoleTemplates(): RoleTemplate[]
  saveRoleTemplate(template: unknown): RoleTemplate[]
  deleteRoleTemplate(id: string): RoleTemplate[]
  getSettings(): AppSettings
  setSetting<K extends keyof AppSettings>(key: K, value: AppSettings[K]): AppSettings
}

export function createSettingsStore({ backend, warn = console.warn }: SettingsStoreDeps): SettingsStore {
  function readProfiles(): Profile[] {
    const raw = backend.get('profiles')
    const profiles = parseProfiles(raw)
    if (Array.isArray(raw) && raw.length !== profiles.length) {
      warn(`[settings] dropped ${raw.length - profiles.length} invalid profile(s)`)
    }
    return profiles
  }

  function readProviders(): ProviderConfig[] {
    const raw = backend.get('providers')
    const providers = parseProviderConfigs(raw)
    if (Array.isArray(raw) && raw.length !== providers.length) {
      warn(`[settings] dropped ${raw.length - providers.length} invalid provider config(s)`)
    }
    return providers
  }

  function readRoleTemplates(): RoleTemplate[] {
    const raw = backend.get('roleTemplates')
    if (!Array.isArray(raw)) return []
    const seen = new Set<string>()
    const templates: RoleTemplate[] = []
    for (const entry of raw) {
      const parsed = roleTemplateSchema.safeParse(entry)
      if (!parsed.success || seen.has(parsed.data.id)) continue
      seen.add(parsed.data.id)
      templates.push(parsed.data)
    }
    if (raw.length !== templates.length) {
      warn(`[settings] dropped ${raw.length - templates.length} invalid role template(s)`)
    }
    return templates
  }

  function upsert<T extends { id: string }>(list: T[], entry: T): T[] {
    const index = list.findIndex((candidate) => candidate.id === entry.id)
    if (index >= 0) list[index] = entry
    else list.push(entry)
    return list
  }

  return {
    getProfiles: readProfiles,

    getProfile(id) {
      return readProfiles().find((profile) => profile.id === id)
    },

    saveProfile(profile) {
      // Writes validate strictly: a rejected save is a bug the caller must see,
      // unlike a legacy row on read.
      const parsed = profileSchema.parse(profile)
      const profiles = upsert(readProfiles(), parsed)
      backend.set('profiles', profiles)
      return profiles
    },

    deleteProfile(id) {
      const profiles = readProfiles().filter((profile) => profile.id !== id)
      backend.set('profiles', profiles)
      return profiles
    },

    getProviders: readProviders,

    saveProvider(config) {
      const parsed = providerConfigSchema.parse(config)
      const providers = upsert(readProviders(), parsed)
      backend.set('providers', providers)
      return providers
    },

    /**
     * Removing a stored entry that shadows a preset is exactly "reset to
     * preset" — the preset reappears in {@link effectiveProviders}.
     */
    deleteProvider(id) {
      const providers = readProviders().filter((provider) => provider.id !== id)
      backend.set('providers', providers)
      return providers
    },

    effectiveProviders() {
      return mergeProviderConfigs(providerPresets(), readProviders())
    },

    getRoleTemplates: readRoleTemplates,

    saveRoleTemplate(template) {
      const parsed = roleTemplateSchema.parse(template)
      const templates = upsert(readRoleTemplates(), parsed)
      backend.set('roleTemplates', templates)
      return templates
    },

    deleteRoleTemplate(id) {
      const templates = readRoleTemplates().filter((template) => template.id !== id)
      backend.set('roleTemplates', templates)
      return templates
    },

    getSettings: readSettings,

    setSetting(key, value) {
      const field = appSettingsSchema.shape[key] as z.ZodTypeAny
      backend.set(key, field.parse(value))
      return readSettings()
    }
  }

  function readSettings(): AppSettings {
    const raw: Record<string, unknown> = {}
    for (const key of SETTINGS_KEYS) {
      const value = backend.get(key)
      if (value !== undefined) raw[key] = value
    }
    const parsed = appSettingsSchema.safeParse(raw)
    if (parsed.success) return parsed.data
    // One bad key must not reset every other one: fall back per key.
    warn('[settings] invalid settings section — falling back per key')
    const repaired: Record<string, unknown> = {}
    for (const key of SETTINGS_KEYS) {
      const field = appSettingsSchema.shape[key] as z.ZodTypeAny
      const value = field.safeParse(raw[key])
      repaired[key] = value.success ? value.data : defaultSetting(key)
    }
    return appSettingsSchema.parse(repaired)
  }
}

function createElectronBackend(): SettingsBackend {
  const store = new Store<Record<string, unknown>>({
    name: STORE_NAME,
    defaults: {
      version: STORE_VERSION,
      profiles: [],
      providers: [],
      roleTemplates: []
    }
  })
  // Stamped, not migrated: a future v2 decides deliberately what to do with v1.
  if (store.get('version') !== STORE_VERSION) store.set('version', STORE_VERSION)
  return {
    get: (key) => store.get(key),
    set: (key, value) => store.set(key, value)
  }
}

let instance: SettingsStore | undefined

/**
 * The app-wide store. Constructed on first use so importing this module (or
 * anything that lazily reaches it, like model discovery) never requires an
 * Electron runtime.
 */
export function settings(): SettingsStore {
  if (!instance) instance = createSettingsStore({ backend: createElectronBackend() })
  return instance
}

/** Test seam: swap in an in-memory store, or reset with `undefined`. */
export function setSettingsStoreForTesting(store: SettingsStore | undefined): void {
  instance = store
}

export const getProfiles = (): Profile[] => settings().getProfiles()
export const getProfile = (id: string): Profile | undefined => settings().getProfile(id)
export const saveProfile = (profile: unknown): Profile[] => settings().saveProfile(profile)
export const deleteProfile = (id: string): Profile[] => settings().deleteProfile(id)
export const getProviders = (): ProviderConfig[] => settings().getProviders()
export const saveProvider = (config: unknown): ProviderConfig[] => settings().saveProvider(config)
export const deleteProvider = (id: string): ProviderConfig[] => settings().deleteProvider(id)
export const effectiveProviders = (): ProviderConfig[] => settings().effectiveProviders()
export const getRoleTemplates = (): RoleTemplate[] => settings().getRoleTemplates()
export const saveRoleTemplate = (template: unknown): RoleTemplate[] =>
  settings().saveRoleTemplate(template)
export const deleteRoleTemplate = (id: string): RoleTemplate[] => settings().deleteRoleTemplate(id)
export const getSettings = (): AppSettings => settings().getSettings()
export const setSetting = <K extends keyof AppSettings>(
  key: K,
  value: AppSettings[K]
): AppSettings => settings().setSetting(key, value)
