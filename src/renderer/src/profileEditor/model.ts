/**
 * The profile editor's form model — draft ⇄ Profile, and validation.
 *
 * A form field is a string; a profile is a typed record with optionals that
 * must be ABSENT rather than empty ("no model" means the CLI's own default, and
 * writing `model: ''` would persist a lie). This module owns that conversion in
 * one place and validates the result with the very schema the store will apply,
 * so the editor can never show "saved" for something the store would reject.
 *
 * Pure functions, no DOM — unit-tested in plain Node.
 */
import { z } from 'zod'
import {
  createLocalId,
  profileSchema,
  type Profile,
  type RoleTemplate
} from '@shared/schema/profile'
import type { EffortLevel } from '@shared/schema/provider'
import { collapseModelVariants } from '@shared/models'
import { EDITOR_STRINGS } from './strings'

/** `''` means "not set" for every optional field in the form. */
export type EffortChoice = '' | EffortLevel

export interface SlotDraft {
  id: string
  roleId: string
  providerId: string
  model: string
  effort: EffortChoice
  maxCount: string
}

export interface ProfileDraft {
  id: string
  name: string
  repoPath: string
  orchestrator: {
    providerId: string
    model: string
    effort: EffortChoice
  }
  slots: SlotDraft[]
  maxSubagents: string
  /** Press Enter for the agent after an assignment was typed in. */
  autoSubmitTasks: boolean
  /** Carried through untouched — the zone editor owns it (M4). */
  zones?: Profile['zones']
}

/** Field-keyed errors: `name`, `repoPath`, `slots.0.model`, `form`. */
export type DraftErrors = Record<string, string>

export function emptyDraft(defaultProviderId: string, id = createLocalId('profile')): ProfileDraft {
  return {
    id,
    name: '',
    repoPath: '',
    orchestrator: { providerId: defaultProviderId, model: '', effort: '' },
    slots: [],
    maxSubagents: '',
    autoSubmitTasks: true
  }
}

export function draftFromProfile(profile: Profile): ProfileDraft {
  return {
    id: profile.id,
    name: profile.name,
    repoPath: profile.repoPath,
    orchestrator: {
      providerId: profile.orchestrator.providerId,
      model: profile.orchestrator.model ?? '',
      effort: profile.orchestrator.effort ?? ''
    },
    slots: profile.slots.map((slot) => ({
      id: slot.id,
      roleId: slot.roleId,
      providerId: slot.providerId,
      model: slot.model ?? '',
      effort: slot.effort ?? '',
      maxCount: slot.maxCount === undefined ? '' : String(slot.maxCount)
    })),
    maxSubagents: profile.maxSubagents === undefined ? '' : String(profile.maxSubagents),
    autoSubmitTasks: profile.autoSubmitTasks,
    zones: profile.zones
  }
}

export function newSlotDraft(roleId: string, providerId: string, id?: string): SlotDraft {
  return {
    id: id ?? createLocalId('slot'),
    roleId,
    providerId,
    model: '',
    effort: '',
    maxCount: ''
  }
}

/** `''` → absent, `'3'` → 3, garbage → NaN so the schema rejects it visibly. */
function optionalNumber(value: string): number | undefined {
  const text = value.trim()
  if (!text) return undefined
  return Number(text)
}

function optionalText(value: string): string | undefined {
  const text = value.trim()
  return text ? text : undefined
}

/** The shape the store gets — optionals omitted, not emptied. */
export function toProfileInput(draft: ProfileDraft): unknown {
  return {
    id: draft.id,
    name: draft.name.trim(),
    repoPath: draft.repoPath.trim(),
    orchestrator: {
      providerId: draft.orchestrator.providerId,
      ...(optionalText(draft.orchestrator.model)
        ? { model: draft.orchestrator.model.trim() }
        : {}),
      ...(draft.orchestrator.effort ? { effort: draft.orchestrator.effort } : {})
    },
    slots: draft.slots.map((slot) => ({
      id: slot.id,
      roleId: slot.roleId,
      providerId: slot.providerId,
      ...(optionalText(slot.model) ? { model: slot.model.trim() } : {}),
      ...(slot.effort ? { effort: slot.effort } : {}),
      ...(optionalNumber(slot.maxCount) === undefined
        ? {}
        : { maxCount: optionalNumber(slot.maxCount) })
    })),
    ...(optionalNumber(draft.maxSubagents) === undefined
      ? {}
      : { maxSubagents: optionalNumber(draft.maxSubagents) }),
    autoSubmitTasks: draft.autoSubmitTasks,
    ...(draft.zones ? { zones: draft.zones } : {})
  }
}

/** Zod paths → the form's field keys (`slots.0.maxCount`). */
export function issuePath(issue: z.ZodIssue): string {
  return issue.path.join('.') || 'form'
}

/**
 * German message for a field. The schema's own messages are English and
 * developer-facing ("String must contain at least 1 character(s)"), so the
 * fields a user can actually get wrong are named explicitly and everything else
 * degrades to one honest generic line instead of leaking zod prose into the UI.
 */
export function messageForPath(path: string): string {
  const errors = EDITOR_STRINGS.errors
  if (path === 'name') return errors.name
  if (path === 'repoPath') return errors.repoPath
  if (path === 'maxSubagents') return errors.maxSubagents
  if (path.endsWith('providerId')) return errors.provider
  if (path.endsWith('roleId')) return errors.role
  if (path.endsWith('maxCount')) return errors.maxCount
  return errors.generic
}

export type ValidationResult =
  | { ok: true; profile: Profile }
  | { ok: false; errors: DraftErrors }

/**
 * Validate a draft the way the store will. The repo path is additionally
 * REQUIRED here although the schema allows an empty one: an empty path is a
 * legal half-finished record, but a profile you cannot start is not what the
 * user meant when they pressed save.
 */
export function validateDraft(draft: ProfileDraft): ValidationResult {
  const errors: DraftErrors = {}
  if (!draft.repoPath.trim()) errors.repoPath = EDITOR_STRINGS.errors.repoPath

  const parsed = profileSchema.safeParse(toProfileInput(draft))
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const path = issuePath(issue)
      if (!errors[path]) errors[path] = messageForPath(path)
    }
  }
  if (Object.keys(errors).length > 0) return { ok: false, errors }
  if (!parsed.success) return { ok: false, errors: { form: EDITOR_STRINGS.errors.generic } }
  return { ok: true, profile: parsed.data }
}

/**
 * Datalist entries for the model combo: one row per collapsed variant, plus
 * every dated snapshot — the CLI may only accept the exact spelling it
 * advertised, so nothing that was discovered is hidden from the user.
 */
export function modelOptions(models: readonly string[]): string[] {
  return collapseModelVariants(models).flatMap((variant) => [variant.id, ...variant.snapshots])
}

/** Marker value of the "define your own role" entry in the role select. */
export const CUSTOM_ROLE_VALUE = '__custom__'

export interface RoleOption {
  id: string
  name: string
  color: string
}

/** Role select entries with their accent colour, custom roles last. */
export function roleOptions(
  templates: readonly RoleTemplate[],
  colorOf: (roleId: string, index: number) => string
): RoleOption[] {
  return templates.map((template, index) => ({
    id: template.id,
    name: template.name,
    color: colorOf(template.id, index)
  }))
}

/** A custom role template, ready for `roles:save`. */
export function customRoleTemplate(name: string, prompt: string, id?: string): RoleTemplate {
  return {
    id: id ?? createLocalId('role'),
    name: name.trim(),
    prompt: prompt.trim(),
    builtin: false
  }
}
