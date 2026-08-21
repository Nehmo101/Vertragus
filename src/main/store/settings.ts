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
 * 2. **No migrations.** This is a fresh store (`vertragus-v2.json`, version 1)
 *    with no data to inherit. The old repo's migration chain was a permanent
 *    source of "why is my profile different now"; if v2 ever needs one, it gets
 *    one deliberately, not by accident.
 *
 * The file name is `vertragus-v2` and not `vertragus` for a reason that cost a
 * boot to find: the archived app is also called "vertragus", so both share
 * `%APPDATA%\vertragus\vertragus.json`. Every start of this app read the old
 * app's records, dropped all seven of them as invalid, and wrote its own —
 * which the old app would then have dropped in turn. Separate files end that.
 * The one exception is {@link adoptLegacyStore}: on the very first start, rows
 * the OLD file holds in the NEW format are taken over once (see there).
 *
 * The backing store is injectable so every rule above is unit-testable without
 * an Electron runtime — electron-store itself is only constructed lazily, on
 * first real use inside the app.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import Store from 'electron-store'
import { z } from 'zod'
import { AGENT_POLICIES, type AgentPolicy } from '@shared/agentPolicy'
import { normalizeAppearance } from '@shared/appearance'
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
import {
  MAX_REPO_NOTES_PER_PROFILE,
  MAX_RUN_RETROS,
  modelLearningSchema,
  parseModelLearnings,
  parseRepoNotes,
  parseRunRetros,
  repoNoteSchema,
  runRetroSchema,
  type ModelLearning,
  type RepoNote,
  type RunRetro
} from '@shared/schema/retro'
import { providerPresets } from '@main/providers/presets'

export const STORE_NAME = 'vertragus-v2'
/** The archived app's file in the same userData folder — read once, never written. */
export const LEGACY_STORE_NAME = 'vertragus'
export const STORE_VERSION = 1

export const panelBoundsSchema = z
  .object({
    edge: z.enum(['left', 'right']),
    /** Vertical offset of the panel on its edge, in screen pixels. */
    y: z.number().finite()
  })
  .strict()
export type PanelBounds = z.infer<typeof panelBoundsSchema>

/**
 * How see-through the app is. Validated by {@link normalizeAppearance} rather
 * than by a field-by-field zod object on purpose: every value here is a
 * clamped number, so an out-of-range one is a slider that went too far, never
 * an error worth failing a whole settings read over. `preprocess` also means
 * `undefined` parses — an install from before this setting existed reads as
 * the design defaults instead of dropping its `ui` section.
 */
export const appearanceSchema = z.preprocess(
  normalizeAppearance,
  z
    .object({
      translucent: z.boolean(),
      restOpacity: z.number(),
      hoverOpacity: z.number(),
      focusOpacity: z.number(),
      surfaceTransparency: z.number()
    })
    .strict()
)

export const uiSettingsSchema = z
  .object({
    panelBounds: panelBoundsSchema.optional(),
    theme: z.enum(['dark', 'light']).default('dark'),
    locale: z.enum(['de', 'en']).default('de'),
    appearance: appearanceSchema,
    /**
     * WP-7: the user closed the first-run card. NOT the card's trigger — that
     * stays "there is no profile yet", which is true again after a reinstall
     * and needs nothing persisted. This flag only records the one thing the
     * trigger cannot know: that somebody looked at the card and would rather
     * find their own way. Defaulting to false means an install from before it
     * existed reads as "never dismissed", which is the truth.
     */
    onboardingDismissed: z.boolean().default(false)
  })
  .strict()
export type UiSettings = z.infer<typeof uiSettingsSchema>

/**
 * Remote access — opt-in, off by default. `bindAddress` empty means "the
 * auto-detected Tailscale address"; a concrete address (a LAN IP, or
 * `0.0.0.0`) is a deliberate override set in the settings window. The pairing
 * token is stored ENCRYPTED (Electron `safeStorage`, base64) because
 * electron-store is plaintext JSON on disk — the encryption happens in the
 * remote wiring, this schema only carries the opaque ciphertext. A 0600
 * file under userData is the restart-safe copy when the keychain is missing.
 */
export const remoteSettingsSchema = z
  .object({
    enabled: z.boolean().default(false),
    /** '' = auto (Tailscale); otherwise the exact bind address. */
    bindAddress: z.string().max(64).default(''),
    port: z.number().int().min(1).max(65_535).default(9482),
    pairingTokenEncrypted: z.string().max(4_000).optional()
  })
  .strict()
export type RemoteSettings = z.infer<typeof remoteSettingsSchema>

export const appSettingsSchema = z
  .object({
    ui: uiSettingsSchema.default({}),
    remote: remoteSettingsSchema.default({}),
    /** Master switch above every slot's yolo flag. Subagents default to yolo. */
    yoloMaster: z.boolean().default(true),
    /**
     * D4: the three-tier policy behind the yolo boolean. Optional on purpose —
     * a store from before D4 has only `yoloMaster`, and
     * {@link effectiveAgentPolicy} derives the tier from it. `setSetting`
     * mirrors the two keys so they can never disagree.
     */
    agentPolicy: z.enum(AGENT_POLICIES).optional(),
    /** Electron accelerator; registration failure must be shown, never swallowed. */
    hideAllHotkey: z.string().trim().min(1).max(80).default('Control+Alt+V'),
    autostart: z.boolean().default(false),
    /**
     * `main` follows every green main build, `stable` only tagged releases.
     * Default `main`: this app ships from main, and a user who never opens the
     * settings should still get fixes.
     */
    updateChannel: z.enum(['main', 'stable']).default('main'),
    /** `{ providerId: { modelId: lastSeenAtMs } }` — see providers/discovery. */
    modelMemory: modelMemorySchema.default({})
  })
  .strict()
export type AppSettings = z.infer<typeof appSettingsSchema>
export type UpdateChannel = AppSettings['updateChannel']

/** Keys of the store's top-level sections. */
export const SETTINGS_KEYS = [
  'ui',
  'remote',
  'yoloMaster',
  'agentPolicy',
  'hideAllHotkey',
  'autostart',
  'updateChannel',
  'modelMemory'
] as const

/**
 * D4: the tier a subagent actually runs under. The stored `agentPolicy` wins;
 * a store from before D4 falls back to the legacy boolean — `yoloMaster` on
 * was always "act without asking", off was always "the CLI asks in its
 * terminal".
 */
export function effectiveAgentPolicy(
  value: Pick<AppSettings, 'agentPolicy' | 'yoloMaster'>
): AgentPolicy {
  return value.agentPolicy ?? (value.yoloMaster ? 'yolo' : 'ask-user')
}

export interface SettingsBackend {
  get(key: string): unknown
  set(key: string, value: unknown): void
}

/**
 * Map an OS locale (`app.getLocale()`, BCP-47-ish) onto a shipped UI locale:
 * any German variant (de, de-DE, de-AT, de_CH…) stays German, everything else
 * gets English. Pure and exported so the rule is unit-testable without
 * Electron.
 */
export function defaultLocaleForOs(osLocale: string | undefined): UiSettings['locale'] {
  return osLocale?.toLowerCase().startsWith('de') ? 'de' : 'en'
}

export interface SettingsStoreDeps {
  backend: SettingsBackend
  /** Where dropped rows are reported. Injectable so tests can assert on it. */
  warn?: (message: string) => void
}

function defaultSetting<K extends keyof AppSettings>(key: K): AppSettings[K] {
  return appSettingsSchema.parse({})[key]
}

/** Fail-soft read of the role-template list: invalid and duplicate rows drop. */
export function parseRoleTemplates(raw: unknown): RoleTemplate[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  const templates: RoleTemplate[] = []
  for (const entry of raw) {
    const parsed = roleTemplateSchema.safeParse(entry)
    if (!parsed.success || seen.has(parsed.data.id)) continue
    seen.add(parsed.data.id)
    templates.push(parsed.data)
  }
  return templates
}

// --- the one-time legacy adoption ----------------------------------------

/**
 * What the OLD `vertragus.json` can contribute to a brand-new `vertragus-v2`.
 *
 * This is NOT a migration and must never become one: the archived app's schema
 * is a different app's schema. It exists because both apps shared one file for
 * a day, so anything the user created in the new app during that day sits in
 * the old file. Only rows that the CURRENT schema validates are taken over —
 * everything else is left where it is, and the old file is never written to.
 *
 * Runs exactly once: `createElectronBackend` calls it only when the v2 file
 * does not exist yet. An empty result (the normal case for a genuine legacy
 * file) means nothing is written at all.
 */
export function adoptLegacyStore(legacy: unknown): Record<string, unknown> {
  if (!legacy || typeof legacy !== 'object' || Array.isArray(legacy)) return {}
  const raw = legacy as Record<string, unknown>
  const adopted: Record<string, unknown> = {}

  const profiles = parseProfiles(raw.profiles)
  if (profiles.length > 0) adopted.profiles = profiles
  const providers = parseProviderConfigs(raw.providers)
  if (providers.length > 0) adopted.providers = providers
  const roleTemplates = parseRoleTemplates(raw.roleTemplates)
  if (roleTemplates.length > 0) adopted.roleTemplates = roleTemplates

  // Settings key by key: one unrecognized value must not cost the others.
  for (const key of SETTINGS_KEYS) {
    if (raw[key] === undefined) continue
    const field = appSettingsSchema.shape[key] as z.ZodTypeAny
    const parsed = field.safeParse(raw[key])
    if (parsed.success) adopted[key] = parsed.data
  }
  return adopted
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
  /** Newest first, bounded at {@link MAX_RUN_RETROS}. */
  getRunRetros(): RunRetro[]
  recordRunRetro(retro: unknown): RunRetro[]
  getModelLearnings(): ModelLearning[]
  /** Replace the whole list — the merge itself lives in shared/retro/learnings. */
  setModelLearnings(learnings: readonly unknown[]): ModelLearning[]
  deleteModelLearning(id: string): ModelLearning[]
  /** E2: repo notes per profile, newest first, bounded per profile. */
  getRepoNotes(profileId?: string): RepoNote[]
  addRepoNotes(profileId: string, notes: readonly string[]): RepoNote[]
  deleteRepoNote(id: string): RepoNote[]
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
    const templates = parseRoleTemplates(raw)
    if (raw.length !== templates.length) {
      warn(`[settings] dropped ${raw.length - templates.length} invalid role template(s)`)
    }
    return templates
  }

  function readRunRetros(): RunRetro[] {
    const raw = backend.get('runRetros')
    const retros = parseRunRetros(raw)
    if (Array.isArray(raw) && raw.length !== retros.length) {
      warn(`[settings] dropped ${raw.length - retros.length} invalid run retro(s)`)
    }
    return retros
  }

  function readRepoNotes(): RepoNote[] {
    const raw = backend.get('repoNotes')
    const notes = parseRepoNotes(raw)
    if (Array.isArray(raw) && raw.length !== notes.length) {
      warn(`[settings] dropped ${raw.length - notes.length} invalid repo note(s)`)
    }
    return notes
  }

  function readModelLearnings(): ModelLearning[] {
    const raw = backend.get('modelLearnings')
    const learnings = parseModelLearnings(raw)
    if (Array.isArray(raw) && raw.length !== learnings.length) {
      warn(`[settings] dropped ${raw.length - learnings.length} invalid model learning(s)`)
    }
    return learnings
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
      // Zones are edited out-of-band (the overlay), not by the profile form.
      // A form save that simply omits `zones` must not wipe a layout the user
      // just drew — only an explicit `zones` field (including `{ zones: [] }`)
      // replaces what is stored.
      const existing = readProfiles().find((entry) => entry.id === parsed.id)
      const withZones =
        parsed.zones === undefined && existing?.zones
          ? { ...parsed, zones: existing.zones }
          : parsed
      // E6: `extraMcp` has no form field either — a slot save that omits it
      // keeps what the same slot (by id) already stored. `extraMcp: []`
      // explicitly clears it.
      const next = {
        ...withZones,
        slots: withZones.slots.map((slot) => {
          if (slot.extraMcp !== undefined) return slot
          const kept = existing?.slots.find((entry) => entry.id === slot.id)?.extraMcp
          return kept ? { ...slot, extraMcp: kept } : slot
        })
      }
      const profiles = upsert(readProfiles(), next)
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

    getRunRetros: readRunRetros,

    recordRunRetro(retro) {
      const parsed = runRetroSchema.parse(retro)
      const retros = upsert(readRunRetros(), parsed)
      retros.sort((a, b) => b.endedAt - a.endedAt)
      const bounded = retros.slice(0, MAX_RUN_RETROS)
      backend.set('runRetros', bounded)
      return bounded
    },

    getModelLearnings: readModelLearnings,

    setModelLearnings(learnings) {
      const parsed = learnings.map((entry) => modelLearningSchema.parse(entry))
      backend.set('modelLearnings', parsed)
      return parsed
    },

    deleteModelLearning(id) {
      const learnings = readModelLearnings().filter((learning) => learning.id !== id)
      backend.set('modelLearnings', learnings)
      return learnings
    },

    getRepoNotes(profileId) {
      const notes = readRepoNotes()
      return profileId ? notes.filter((note) => note.profileId === profileId) : notes
    },

    addRepoNotes(profileId, notes) {
      const existing = readRepoNotes()
      const now = Date.now()
      const fresh = notes
        .map((note) => note.trim())
        .filter(Boolean)
        // Reinforcing an identical note must not duplicate it.
        .filter(
          (note) =>
            !existing.some((entry) => entry.profileId === profileId && entry.note === note)
        )
        .map((note, index) =>
          repoNoteSchema.parse({
            // Bursts land in the same millisecond — the random suffix keeps
            // ids unique, and parseRepoNotes dedupes BY id on read.
            id: `${profileId}-${now}-${index}-${Math.random().toString(36).slice(2, 8)}`,
            profileId,
            note,
            createdAt: now
          })
        )
      // Newest first; the per-profile cap drops the oldest, other profiles untouched.
      const merged = [...fresh, ...existing]
      const kept: RepoNote[] = []
      const perProfile = new Map<string, number>()
      for (const note of merged) {
        const count = perProfile.get(note.profileId) ?? 0
        if (count >= MAX_REPO_NOTES_PER_PROFILE) continue
        perProfile.set(note.profileId, count + 1)
        kept.push(note)
      }
      backend.set('repoNotes', kept)
      return kept
    },

    deleteRepoNote(id) {
      const notes = readRepoNotes().filter((note) => note.id !== id)
      backend.set('repoNotes', notes)
      return notes
    },

    getSettings: readSettings,

    setSetting(key, value) {
      const field = appSettingsSchema.shape[key] as z.ZodTypeAny
      backend.set(key, field.parse(value))
      // D4: one truth, two representations. The panel's yolo toggle writes the
      // boolean, the settings picker writes the tier — whichever landed, the
      // other key follows, so no reader can see them disagree.
      if (key === 'agentPolicy' && value !== undefined) {
        backend.set('yoloMaster', value === 'yolo')
      } else if (key === 'yoloMaster') {
        backend.set('agentPolicy', value ? 'yolo' : 'ask-user')
      }
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

/**
 * Read the archived app's file WITHOUT electron-store — constructing a second
 * Store on that name would create (and default-fill) another app's config.
 * Anything unreadable is simply "no legacy data".
 */
function readLegacyStoreFile(userDataDir: string): unknown {
  try {
    return JSON.parse(readFileSync(join(userDataDir, `${LEGACY_STORE_NAME}.json`), 'utf8'))
  } catch {
    return undefined
  }
}

function createElectronBackend(): SettingsBackend {
  const userDataDir = app.getPath('userData')
  // Decided BEFORE the Store is constructed — constructing it writes the file.
  const firstRun = !existsSync(join(userDataDir, `${STORE_NAME}.json`))

  const store = new Store<Record<string, unknown>>({
    name: STORE_NAME,
    defaults: {
      version: STORE_VERSION,
      profiles: [],
      providers: [],
      roleTemplates: [],
      runRetros: [],
      modelLearnings: []
    }
  })

  if (firstRun) {
    const adopted = adoptLegacyStore(readLegacyStoreFile(userDataDir))
    const keys = Object.keys(adopted)
    if (keys.length > 0) {
      for (const key of keys) store.set(key, adopted[key])
      console.info(`[settings] adopted from ${LEGACY_STORE_NAME}.json: ${keys.join(', ')}`)
    }
  }

  /*
   * WP-1: first-run UI language follows the OS (de* → de, else en).
   *
   * Decision: the zod schema keeps its pure `'de'` default — the schema must
   * stay evaluable without an Electron runtime (tests, the renderer's boot
   * fallback, `mainMessages`' documented fallback all lean on it). The OS
   * derivation therefore lives HERE, in the only place that constructs the
   * real Electron backend, and it MATERIALIZES the choice by writing a `ui`
   * value once. Written, not derived per read, so the decision is stable: a
   * later OS-language change must not silently flip an installation's UI. A
   * stored `ui` (including one adopted from the legacy file above) always
   * wins — this only fills true first runs that have no `ui` at all.
   */
  if (firstRun && store.get('ui') === undefined) {
    try {
      store.set('ui', { locale: defaultLocaleForOs(app.getLocale()) })
    } catch {
      // Unreadable OS locale (stripped runtime, too-early call): write
      // nothing and let the schema default ('de') carry, rather than failing
      // the whole store construction over a nicety.
    }
  }

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
export const getRunRetros = (): RunRetro[] => settings().getRunRetros()
export const recordRunRetro = (retro: unknown): RunRetro[] => settings().recordRunRetro(retro)
export const getModelLearnings = (): ModelLearning[] => settings().getModelLearnings()
export const setModelLearnings = (learnings: readonly unknown[]): ModelLearning[] =>
  settings().setModelLearnings(learnings)
export const deleteModelLearning = (id: string): ModelLearning[] =>
  settings().deleteModelLearning(id)
export const getSettings = (): AppSettings => settings().getSettings()
export const setSetting = <K extends keyof AppSettings>(
  key: K,
  value: AppSettings[K]
): AppSettings => settings().setSetting(key, value)
