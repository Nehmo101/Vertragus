/**
 * Portable profile files — export/import of one profile plus the custom
 * roles it actually uses.
 *
 * The envelope is versioned and strict. Zones are never part of a portable
 * copy: they are rectangles on THIS machine's displays, and importing them
 * onto another layout would pin windows to the wrong monitor. Everything
 * else that lives on the profile (slots, playbooks, automation, extra MCP,
 * per-identity system prompts) travels, together with custom role templates
 * the slots reference.
 *
 * Built-in role templates (Worker, Tester, …) and the reserved orchestrator /
 * lead identities stay in code — they are not exported, and an incoming file
 * that names them as templates is ignored. Per-profile `rolePrompts` extras
 * are the overlay that travels.
 *
 * Import always creates a NEW profile (fresh ids, fresh slot ids). Existing
 * rows are never overwritten. A custom role id that already exists is reused
 * when the name and prompt match, and remapped onto a new id otherwise, so
 * importing cannot silently replace a role the destination already uses.
 */
import { z } from 'zod'
import {
  LEAD_ROLE_ID,
  ORCHESTRATOR_ROLE_ID,
  builtinRoleTemplate
} from '../prompts/roles'
import {
  MAX_ROLE_PROMPTS,
  createLocalId,
  duplicateProfile,
  profileSchema,
  roleTemplateSchema,
  type Profile,
  type RoleTemplate
} from './profile'

export const PROFILE_BUNDLE_KIND = 'vertragus.profile'
export const PROFILE_BUNDLE_VERSION = 1
/** Bug net: a profile file is JSON, not an attachment dump. */
export const PROFILE_BUNDLE_MAX_BYTES = 1_048_576

export const profileBundleSchema = z
  .object({
    kind: z.literal(PROFILE_BUNDLE_KIND),
    version: z.literal(PROFILE_BUNDLE_VERSION),
    profile: profileSchema,
    roleTemplates: z.array(roleTemplateSchema).max(MAX_ROLE_PROMPTS).default([])
  })
  .strict()
export type ProfileBundle = z.infer<typeof profileBundleSchema>

/** Shipped identities — never serialized as custom templates. */
export function isShippedRoleId(roleId: string): boolean {
  return (
    roleId === ORCHESTRATOR_ROLE_ID ||
    roleId === LEAD_ROLE_ID ||
    builtinRoleTemplate(roleId) !== undefined
  )
}

/** Custom role ids a profile actually staffs or overlays. */
export function referencedCustomRoleIds(
  profile: Pick<Profile, 'slots' | 'rolePrompts'>
): Set<string> {
  const ids = new Set<string>()
  for (const slot of profile.slots) {
    if (!isShippedRoleId(slot.roleId)) ids.add(slot.roleId)
  }
  for (const entry of profile.rolePrompts ?? []) {
    if (!isShippedRoleId(entry.roleId)) ids.add(entry.roleId)
  }
  return ids
}

/** Snapshot ready to write: zones gone, only the custom roles this profile uses. */
export function packProfileBundle(
  profile: Profile,
  customTemplates: readonly RoleTemplate[] = []
): ProfileBundle {
  const portable = { ...profile }
  delete portable.zones
  const needed = referencedCustomRoleIds(portable)
  const roleTemplates = customTemplates.filter(
    (template) => needed.has(template.id) && !isShippedRoleId(template.id)
  )
  return profileBundleSchema.parse({
    kind: PROFILE_BUNDLE_KIND,
    version: PROFILE_BUNDLE_VERSION,
    profile: portable,
    roleTemplates
  })
}

export function serializeProfileBundle(bundle: ProfileBundle): string {
  return `${JSON.stringify(bundle, null, 2)}\n`
}

export type ParseProfileBundleFailure = 'json' | 'schema'

export type ParseProfileBundleResult =
  | { ok: true; bundle: ProfileBundle }
  | { ok: false; reason: ParseProfileBundleFailure }

/**
 * Read a file's JSON. A well-formed envelope wins; a bare profile object
 * (a row copied out of the store) is accepted as a bundle with no extra
 * templates, so a hand-edited export still imports.
 */
export function parseProfileBundleText(text: string): ParseProfileBundleResult {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return { ok: false, reason: 'json' }
  }
  const envelope = profileBundleSchema.safeParse(raw)
  if (envelope.success) {
    return { ok: true, bundle: packProfileBundle(envelope.data.profile, envelope.data.roleTemplates) }
  }
  const profile = profileSchema.safeParse(raw)
  if (profile.success) return { ok: true, bundle: packProfileBundle(profile.data, []) }
  return { ok: false, reason: 'schema' }
}

export interface AdoptRoleTemplatesResult {
  /** Templates the destination does not already have — save these. */
  templates: RoleTemplate[]
  /** Incoming role id → id to use on the imported profile (only when remapped). */
  remap: ReadonlyMap<string, string>
}

function templatesMatch(left: RoleTemplate, right: RoleTemplate): boolean {
  return left.name === right.name && left.prompt === right.prompt
}

/**
 * Decide which incoming custom roles to add, and how to rewrite ids when the
 * destination already has a different role under the same key.
 */
export function adoptRoleTemplates(
  incoming: readonly RoleTemplate[],
  existing: readonly RoleTemplate[],
  createId: () => string = () => createLocalId('role')
): AdoptRoleTemplatesResult {
  const byId = new Map(existing.map((template) => [template.id, template]))
  const taken = new Set(byId.keys())
  const templates: RoleTemplate[] = []
  const remap = new Map<string, string>()

  for (const raw of incoming) {
    if (isShippedRoleId(raw.id)) continue
    const current = byId.get(raw.id)
    if (!current) {
      templates.push(raw)
      byId.set(raw.id, raw)
      taken.add(raw.id)
      continue
    }
    if (templatesMatch(current, raw)) continue
    let nextId = createId()
    while (taken.has(nextId) || isShippedRoleId(nextId)) nextId = createId()
    const renamed = { ...raw, id: nextId, builtin: false }
    templates.push(renamed)
    byId.set(nextId, renamed)
    taken.add(nextId)
    remap.set(raw.id, nextId)
  }

  return { templates, remap }
}

function remapProfileRoles(profile: Profile, remap: ReadonlyMap<string, string>): Profile {
  if (remap.size === 0) return profile
  return {
    ...profile,
    slots: profile.slots.map((slot) => ({
      ...slot,
      roleId: remap.get(slot.roleId) ?? slot.roleId
    })),
    rolePrompts: profile.rolePrompts?.map((entry) => ({
      ...entry,
      roleId: remap.get(entry.roleId) ?? entry.roleId
    }))
  }
}

export interface ImportProfileFromBundleOptions {
  /** Localized word for the name suffix when the original is taken. */
  importedWord?: string
  id?: string
  createRoleId?: () => string
}

/**
 * A new profile + the custom roles it needs. Never writes; the caller persists
 * both. Zones are stripped even if the file still carried them.
 */
export function importProfileFromBundle(
  bundle: ProfileBundle,
  existing: readonly Profile[] = [],
  existingTemplates: readonly RoleTemplate[] = [],
  options: ImportProfileFromBundleOptions = {}
): { profile: Profile; roleTemplates: RoleTemplate[] } {
  const { templates, remap } = adoptRoleTemplates(
    bundle.roleTemplates,
    existingTemplates,
    options.createRoleId
  )
  const remapped = remapProfileRoles(bundle.profile, remap)
  const profile = duplicateProfile(remapped, existing, {
    copyWord: options.importedWord ?? 'imported',
    keepName: true,
    omitZones: true,
    ...(options.id ? { id: options.id } : {})
  })
  return { profile, roleTemplates: templates }
}

/** `vertragus-<slug>.json` for the save dialog's default filename. */
export function suggestedProfileFilename(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/ß/g, 'ss')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
  return `vertragus-${slug || 'profile'}.json`
}

/** Linux save dialogs often omit the filter extension; JSON is the contract. */
export function ensureJsonExtension(filePath: string): string {
  return filePath.toLowerCase().endsWith('.json') ? filePath : `${filePath}.json`
}
