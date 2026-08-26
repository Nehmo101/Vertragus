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
  DEFAULT_PR_REMOTE,
  profileSchema,
  type Profile,
  type QuestionMode,
  type RoleTemplate
} from '@shared/schema/profile'
import { LEAD_ROLE_ID, ORCHESTRATOR_ROLE_ID } from '@shared/prompts/roles'
import { initialRolePromptDraft } from '@shared/prompts/rolePrompt'
import type { EffortLevel } from '@shared/schema/provider'
import { collapseModelVariants } from '@shared/models'
import type { ModelDiscoveryResult } from '../../../preload'
import type { Translate } from '../i18n'

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
  /** How often the root orchestrator asks the user via ask_user. */
  questionMode: QuestionMode
  /** A3: end-of-work automation — merges without a click, and the auto-PR. */
  automation: {
    autoIntegrate: boolean
    autoPromote: boolean
    autoPr: boolean
    prRemote: string
    prBaseBranch: string
    prDraft: boolean
  }
  /** Carried through untouched — the zone editor owns it (M4). */
  zones?: Profile['zones']
  /**
   * Extra system prompt per identity (`orchestrator`, `lead`, role ids).
   * Empty string in the form means "use the shipped prompt only".
   */
  rolePrompts: Record<string, string>
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
    autoSubmitTasks: true,
    questionMode: 'few',
    automation: emptyAutomationDraft(),
    rolePrompts: initialRolePromptDraft()
  }
}

/** Every automation switch off — the default a new profile starts from. */
export function emptyAutomationDraft(): ProfileDraft['automation'] {
  return {
    autoIntegrate: false,
    autoPromote: false,
    autoPr: false,
    prRemote: '',
    prBaseBranch: '',
    prDraft: false
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
    questionMode: profile.questionMode,
    automation: {
      autoIntegrate: profile.automation.autoIntegrate,
      autoPromote: profile.automation.autoPromote,
      autoPr: profile.automation.autoPr,
      // The schema's own default is shown as an empty field: the placeholder
      // says "origin", and persisting it as typed text would freeze today's
      // default into every profile that never touched the field.
      prRemote: profile.automation.prRemote === DEFAULT_PR_REMOTE ? '' : profile.automation.prRemote,
      prBaseBranch: profile.automation.prBaseBranch ?? '',
      prDraft: profile.automation.prDraft
    },
    zones: profile.zones,
    rolePrompts: Object.fromEntries(
      (profile.rolePrompts ?? []).map((entry) => [entry.roleId, entry.prompt])
    )
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
  const rolePrompts = toRolePromptEntries(draft.rolePrompts)
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
    questionMode: draft.questionMode,
    automation: {
      autoIntegrate: draft.automation.autoIntegrate,
      autoPromote: draft.automation.autoPromote,
      autoPr: draft.automation.autoPr,
      ...(optionalText(draft.automation.prRemote)
        ? { prRemote: draft.automation.prRemote.trim() }
        : {}),
      ...(optionalText(draft.automation.prBaseBranch)
        ? { prBaseBranch: draft.automation.prBaseBranch.trim() }
        : {}),
      prDraft: draft.automation.prDraft
    },
    ...(draft.zones ? { zones: draft.zones } : {}),
    ...(rolePrompts ? { rolePrompts } : {})
  }
}

/** Present entries only — empty textareas must not persist as blank rows. */
function toRolePromptEntries(
  drafts: Record<string, string>
): Array<{ roleId: string; prompt: string }> | undefined {
  const entries = Object.entries(drafts)
    .map(([roleId, prompt]) => ({ roleId, prompt: prompt.trim() }))
    .filter((entry) => entry.prompt.length > 0)
  return entries.length > 0 ? entries : undefined
}

/** Zod paths → the form's field keys (`slots.0.maxCount`). */
export function issuePath(issue: z.ZodIssue): string {
  return issue.path.join('.') || 'form'
}

/**
 * The user-facing message for a field. The schema's own messages are English
 * and developer-facing ("String must contain at least 1 character(s)"), so the
 * fields a user can actually get wrong are named explicitly and everything else
 * degrades to one honest generic line instead of leaking zod prose into the UI.
 *
 * `t` is passed in rather than imported: this module is pure and unit-tested in
 * plain Node, and a captured translator would freeze one language into it.
 */
export function messageForPath(t: Translate, path: string): string {
  if (path === 'name') return t('profileEditor.errors.name')
  if (path === 'repoPath') return t('profileEditor.errors.repoPath')
  if (path === 'maxSubagents') return t('profileEditor.errors.maxSubagents')
  if (path.endsWith('providerId')) return t('profileEditor.errors.provider')
  if (path.endsWith('roleId')) return t('profileEditor.errors.role')
  if (path.endsWith('maxCount')) return t('profileEditor.errors.maxCount')
  if (path === 'automation.prRemote') return t('profileEditor.errors.prRemote')
  if (path === 'automation.prBaseBranch') return t('profileEditor.errors.prBaseBranch')
  if (path.startsWith('rolePrompts')) return t('profileEditor.errors.rolePrompt')
  return t('profileEditor.errors.generic')
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
export function validateDraft(t: Translate, draft: ProfileDraft): ValidationResult {
  const errors: DraftErrors = {}
  if (!draft.repoPath.trim()) errors.repoPath = t('profileEditor.errors.repoPath')

  const parsed = profileSchema.safeParse(toProfileInput(draft))
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const path = issuePath(issue)
      if (!errors[path]) errors[path] = messageForPath(t, path)
    }
  }
  if (Object.keys(errors).length > 0) return { ok: false, errors }
  if (!parsed.success) {
    return { ok: false, errors: { form: t('profileEditor.errors.generic') } }
  }
  return { ok: true, profile: parsed.data }
}

/**
 * Suggestion entries for the model combo: one row per collapsed variant, plus
 * every dated snapshot — the CLI may only accept the exact spelling it
 * advertised, so nothing that was discovered is hidden from the user.
 */
export function modelOptions(models: readonly string[]): string[] {
  return collapseModelVariants(models).flatMap((variant) => [variant.id, ...variant.snapshots])
}

/**
 * Substring filter over the suggestions. Case- and punctuation-insensitive
 * (`opus5` finds `claude-opus-5`) because the id spellings differ per provider
 * and nobody remembers where the dashes go. An empty query shows everything —
 * the list is a picker first and a search box second.
 */
export function filterModelOptions(options: readonly string[], query: string): string[] {
  const needle = query.trim().toLowerCase().replace(/[-._:/\s]/g, '')
  if (!needle) return [...options]
  return options.filter((option) =>
    option.toLowerCase().replace(/[-._:/\s]/g, '').includes(needle)
  )
}

export type ModelStatusTone = 'loading' | 'ok' | 'warn'

export interface ModelComboStatus {
  tone: ModelStatusTone
  /** One short line under the field. */
  text: string
  /** The same, plus whatever failed — the `title` of the field. */
  title: string
}

/**
 * What the combo says about its own list.
 *
 * The picker is never a closed list, so an empty catalogue is legal — but it
 * must SAY so, and say why. "Kann kein Modell auswählen" was the user report
 * for a discovery that had simply not answered yet, and for one whose CLI is a
 * shim that failed to start: both looked identical (an empty text field).
 */
export function modelComboStatus(
  t: Translate,
  catalogue: ModelDiscoveryResult | undefined,
  loading: boolean
): ModelComboStatus {
  const empty = t('profileEditor.modelsEmpty')
  if (!catalogue) {
    const loadingText = t('profileEditor.modelsLoading')
    return loading
      ? { tone: 'loading', text: loadingText, title: loadingText }
      : { tone: 'warn', text: empty, title: empty }
  }

  const detail = catalogue.detail
    ? t('profileEditor.modelsSource', { detail: catalogue.detail })
    : ''
  const withDetail = (text: string): ModelComboStatus['title'] =>
    detail ? `${text} · ${detail}` : text

  if (catalogue.models.length === 0) {
    // The reason belongs on screen, not only in a tooltip: "kann kein Modell
    // auswählen" is unanswerable without the command that failed.
    return { tone: 'warn', text: withDetail(empty), title: withDetail(empty) }
  }
  const summary = `${t('profileEditor.modelsCount', { count: catalogue.models.length })} · ${t(
    `profileEditor.modelsFrom.${catalogue.source}`
  )}`
  // A seeded-only list means the CLI itself said nothing — worth a warning
  // colour, because it is the state where a freshly released model is missing.
  const warn = catalogue.source === 'seed'
  return {
    tone: warn ? 'warn' : 'ok',
    text: warn ? withDetail(summary) : summary,
    title: withDetail(summary)
  }
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

/**
 * Identities that can carry an extra system prompt: Orchestrator, Lead, then
 * every role template. Names stay English (WP-1). Orchestrator/Lead are not
 * role templates, so they are prepended rather than looked up.
 */
export function promptIdentities(
  templates: readonly RoleTemplate[],
  colorOf: (roleId: string, index: number) => string
): RoleOption[] {
  const identities: RoleOption[] = [
    { id: ORCHESTRATOR_ROLE_ID, name: 'Orchestrator', color: colorOf(ORCHESTRATOR_ROLE_ID, 0) },
    { id: LEAD_ROLE_ID, name: 'Lead', color: colorOf(LEAD_ROLE_ID, 0) }
  ]
  const seen = new Set(identities.map((identity) => identity.id))
  for (const [index, template] of templates.entries()) {
    if (seen.has(template.id)) continue
    seen.add(template.id)
    identities.push({
      id: template.id,
      name: template.name,
      color: colorOf(template.id, index)
    })
  }
  return identities
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
