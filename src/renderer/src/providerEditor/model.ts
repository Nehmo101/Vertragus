/**
 * The provider editor's form model — draft ⇄ ProviderConfig, and validation.
 *
 * Same contract as the profile editor's `model.ts`, and for the same reason: a
 * form field is a string, a descriptor is a typed record whose optionals must
 * be ABSENT rather than empty. An empty `modelArg` means "the model is
 * positional", not "the flag is the empty string" — persisting the second would
 * produce a launch that dies on an unknown argument.
 *
 * The stakes are a notch higher here than for a profile: this record is the
 * recipe a CLI is started with, so everything is validated against the very
 * schema the store applies, and nothing is guessed on the way in or out.
 *
 * Pure functions, no DOM — unit-tested in plain Node.
 */
import type { z } from 'zod'
import {
  normalizeProviderId,
  providerConfigSchema,
  type McpAttach,
  type ModelDiscovery,
  type ProviderConfig,
  type ProviderPresetId,
  type ProviderSeed,
  type SystemPromptDelivery
} from '@shared/schema/provider'
import type { Translate } from '../i18n'

/** `''` means "no effort switch at all" — the CLI has no such knob. */
export type EffortStyleChoice = '' | 'flag' | 'template'

export interface ProviderDraft {
  id: string
  /** Set when this descriptor came from (or overrides) a built-in preset. */
  presetId?: ProviderPresetId
  label: string
  command: string
  /** Newline-separated: one argument per line, everywhere in this form. */
  args: string
  yoloArgs: string
  modelArg: string
  effortStyle: EffortStyleChoice
  effortFlag: string
  effortTemplate: string
  versionArgs: string
  authLoginArgs: string
  authStatusArgs: string
  promptKind: SystemPromptDelivery['kind']
  promptFlag: string
  mcpKind: McpAttach['kind']
  mcpConfigArg: string
  mcpStrictArg: string
  mcpAllowedToolsArg: string
  discoveryKind: ModelDiscovery['kind']
  discoveryArgs: string
  discoveryParse: 'lines' | 'json' | 'toml-keys'
  discoveryJsonPath: string
  discoveryPath: string
  discoveryUrl: string
  seedModels: string
  enabled: boolean
  /**
   * Carried, not edited: the seed-handshake tuning has no field in this form
   * (its values are measurements, not preferences — see `providerSeedSchema`).
   * It rides along so saving an edited preset cannot silently drop it. Losing
   * it is not cosmetic: Cursor's `submitDelayMs`/`submitAcceptance` and
   * Ollama's `keyboardWaitMs: 0` are what make the assignment arrive at all.
   */
  seed?: ProviderSeed
}

/** Field-keyed errors: `label`, `command`, `mcpConfigArg`, `form`. */
export type DraftErrors = Record<string, string>

/** One argument per line; blank lines are dropped, not turned into `''`. */
export function toLines(value: string): string[] {
  return value
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
}

export function fromLines(values: readonly string[] | undefined): string {
  return (values ?? []).join('\n')
}

/**
 * A blank descriptor. The MCP kind starts at `none` on purpose: the schema's
 * own default. An unknown CLI has no verified attach surface, and declaring one
 * that does not exist is the failure mode this whole editor is meant to make
 * visible rather than to invent.
 */
export function emptyDraft(): ProviderDraft {
  return {
    id: '',
    label: '',
    command: '',
    args: '',
    yoloArgs: '',
    modelArg: '',
    effortStyle: '',
    effortFlag: '',
    effortTemplate: '',
    versionArgs: '--version',
    authLoginArgs: '',
    authStatusArgs: '',
    promptKind: 'pty',
    promptFlag: '',
    mcpKind: 'none',
    mcpConfigArg: '',
    mcpStrictArg: '',
    mcpAllowedToolsArg: '',
    discoveryKind: 'none',
    discoveryArgs: '',
    discoveryParse: 'lines',
    discoveryJsonPath: '',
    discoveryPath: '',
    discoveryUrl: '',
    seedModels: '',
    enabled: true
  }
}

export function draftFromProvider(config: ProviderConfig): ProviderDraft {
  const draft = emptyDraft()
  const discovery = config.modelDiscovery
  return {
    ...draft,
    id: config.id,
    ...(config.presetId ? { presetId: config.presetId } : {}),
    label: config.label,
    command: config.command,
    args: fromLines(config.args),
    yoloArgs: fromLines(config.yoloArgs),
    modelArg: config.modelArg ?? '',
    effortStyle: config.effortArg?.style ?? '',
    effortFlag: config.effortArg?.flag ?? '',
    effortTemplate: config.effortArg?.style === 'template' ? config.effortArg.template : '',
    versionArgs: fromLines(config.versionArgs),
    authLoginArgs: fromLines(config.auth?.loginArgs),
    authStatusArgs: fromLines(config.auth?.statusArgs),
    promptKind: config.systemPromptDelivery.kind,
    promptFlag:
      config.systemPromptDelivery.kind === 'arg' ||
      config.systemPromptDelivery.kind === 'agent-file'
        ? config.systemPromptDelivery.flag
        : '',
    mcpKind: config.mcp.kind,
    mcpConfigArg: config.mcp.kind === 'claude-json' ? config.mcp.configArg : '',
    mcpStrictArg: config.mcp.kind === 'claude-json' ? (config.mcp.strictArg ?? '') : '',
    mcpAllowedToolsArg:
      config.mcp.kind === 'claude-json' ? (config.mcp.allowedToolsArg ?? '') : '',
    discoveryKind: discovery.kind,
    discoveryArgs: discovery.kind === 'cli' ? fromLines(discovery.args) : '',
    discoveryParse:
      discovery.kind === 'cli' || discovery.kind === 'file' ? discovery.parse : 'lines',
    discoveryJsonPath:
      discovery.kind === 'none' ? '' : (discovery as { jsonPath?: string }).jsonPath ?? '',
    discoveryPath: discovery.kind === 'file' ? discovery.path : '',
    discoveryUrl: discovery.kind === 'http' ? discovery.url : '',
    seedModels: fromLines(config.seedModels),
    enabled: config.enabled,
    ...(config.seed ? { seed: config.seed } : {})
  }
}

function optionalText(value: string): string | undefined {
  const text = value.trim()
  return text ? text : undefined
}

/** The effort descriptor, or nothing when the CLI has no such knob. */
function effortArgInput(draft: ProviderDraft): unknown {
  if (draft.effortStyle === '') return undefined
  if (draft.effortStyle === 'flag') return { style: 'flag', flag: draft.effortFlag.trim() }
  return {
    style: 'template',
    flag: draft.effortFlag.trim(),
    template: draft.effortTemplate.trim()
  }
}

function systemPromptDeliveryInput(draft: ProviderDraft): unknown {
  switch (draft.promptKind) {
    case 'arg':
    case 'agent-file':
      return { kind: draft.promptKind, flag: draft.promptFlag.trim() }
    default:
      return { kind: draft.promptKind }
  }
}

function mcpInput(draft: ProviderDraft): unknown {
  if (draft.mcpKind !== 'claude-json') return { kind: draft.mcpKind }
  return {
    kind: 'claude-json',
    configArg: draft.mcpConfigArg.trim(),
    // Both are genuinely optional: a CLI without a strict mode or without a
    // pre-approval flag still attaches, it is only less contained.
    ...(optionalText(draft.mcpStrictArg) ? { strictArg: draft.mcpStrictArg.trim() } : {}),
    ...(optionalText(draft.mcpAllowedToolsArg)
      ? { allowedToolsArg: draft.mcpAllowedToolsArg.trim() }
      : {})
  }
}

function modelDiscoveryInput(draft: ProviderDraft): unknown {
  const jsonPath = optionalText(draft.discoveryJsonPath)
  switch (draft.discoveryKind) {
    case 'cli':
      return {
        kind: 'cli',
        args: toLines(draft.discoveryArgs),
        parse: draft.discoveryParse === 'toml-keys' ? 'json' : draft.discoveryParse,
        ...(jsonPath ? { jsonPath } : {})
      }
    case 'file':
      return {
        kind: 'file',
        path: draft.discoveryPath.trim(),
        parse: draft.discoveryParse === 'lines' ? 'json' : draft.discoveryParse,
        ...(jsonPath ? { jsonPath } : {})
      }
    case 'http':
      return { kind: 'http', url: draft.discoveryUrl.trim(), jsonPath: jsonPath ?? '' }
    default:
      return { kind: 'none' }
  }
}

/** The shape the store gets — optionals omitted, not emptied. */
export function toProviderInput(draft: ProviderDraft): unknown {
  const effortArg = effortArgInput(draft)
  const loginArgs = toLines(draft.authLoginArgs)
  const statusArgs = toLines(draft.authStatusArgs)
  return {
    id: normalizeProviderId(draft.id) || draft.id.trim(),
    ...(draft.presetId ? { presetId: draft.presetId } : {}),
    label: draft.label.trim(),
    command: draft.command.trim(),
    args: toLines(draft.args),
    yoloArgs: toLines(draft.yoloArgs),
    ...(optionalText(draft.modelArg) ? { modelArg: draft.modelArg.trim() } : {}),
    ...(effortArg ? { effortArg } : {}),
    versionArgs: toLines(draft.versionArgs),
    // No login command at all = no auth block, rather than an empty one.
    ...(loginArgs.length > 0 || statusArgs.length > 0
      ? { auth: { loginArgs, ...(statusArgs.length > 0 ? { statusArgs } : {}) } }
      : {}),
    systemPromptDelivery: systemPromptDeliveryInput(draft),
    mcp: mcpInput(draft),
    modelDiscovery: modelDiscoveryInput(draft),
    seedModels: toLines(draft.seedModels),
    enabled: draft.enabled,
    ...(draft.seed ? { seed: draft.seed } : {})
  }
}

/**
 * Zod paths → the form's field keys.
 *
 * The schema nests (`mcp.configArg`, `modelDiscovery.url`) and the form does
 * not, so a rejection has to be translated or it lands on `form` and the user
 * is told "something is wrong" about a sheet with thirty fields.
 */
export function fieldForPath(path: string): string {
  const map: Record<string, string> = {
    id: 'id',
    label: 'label',
    command: 'command',
    modelArg: 'modelArg',
    'effortArg.flag': 'effortFlag',
    'effortArg.template': 'effortTemplate',
    effortArg: 'effortStyle',
    'auth.loginArgs': 'authLoginArgs',
    'auth.statusArgs': 'authStatusArgs',
    'systemPromptDelivery.flag': 'promptFlag',
    'mcp.configArg': 'mcpConfigArg',
    'mcp.strictArg': 'mcpStrictArg',
    'mcp.allowedToolsArg': 'mcpAllowedToolsArg',
    'modelDiscovery.args': 'discoveryArgs',
    'modelDiscovery.parse': 'discoveryParse',
    'modelDiscovery.jsonPath': 'discoveryJsonPath',
    'modelDiscovery.path': 'discoveryPath',
    'modelDiscovery.url': 'discoveryUrl',
    args: 'args',
    yoloArgs: 'yoloArgs',
    versionArgs: 'versionArgs',
    seedModels: 'seedModels'
  }
  // `args.3` is a rejection of one entry — it belongs on the whole textarea.
  const head = path.replace(/\.\d+$/, '')
  return map[head] ?? map[head.split('.')[0] ?? ''] ?? 'form'
}

/**
 * The user-facing message for a field; the schema's own prose is
 * developer-facing. `t` is a parameter because this module is pure and
 * unit-tested in plain Node — see the profile editor's `model.ts`.
 */
export function messageForField(t: Translate, field: string): string {
  switch (field) {
    case 'id':
      return t('providerEditor.errors.id')
    case 'label':
      return t('providerEditor.errors.label')
    case 'command':
      return t('providerEditor.errors.command')
    case 'effortTemplate':
      return t('providerEditor.errors.effortTemplate')
    case 'effortFlag':
    case 'promptFlag':
    case 'mcpConfigArg':
    case 'mcpStrictArg':
    case 'mcpAllowedToolsArg':
    case 'modelArg':
      return t('providerEditor.errors.flag')
    case 'discoveryPath':
      return t('providerEditor.errors.path')
    case 'discoveryUrl':
      return t('providerEditor.errors.url')
    case 'discoveryJsonPath':
      return t('providerEditor.errors.jsonPath')
    case 'args':
    case 'yoloArgs':
    case 'versionArgs':
    case 'discoveryArgs':
    case 'authLoginArgs':
    case 'authStatusArgs':
    case 'seedModels':
      return t('providerEditor.errors.args')
    default:
      return t('providerEditor.errors.generic')
  }
}

export type ValidationResult =
  | { ok: true; config: ProviderConfig }
  | { ok: false; errors: DraftErrors }

/**
 * Validate a draft the way the store will, plus the two rules the schema
 * cannot know: an id has to survive normalization, and it must not collide with
 * another provider. A duplicate id would silently REPLACE that provider — which
 * for a preset is a feature (that is how "edit a built-in" works) and for a
 * stranger's custom entry is data loss.
 */
export function validateDraft(
  t: Translate,
  draft: ProviderDraft,
  takenIds: readonly string[] = []
): ValidationResult {
  const errors: DraftErrors = {}
  const id = normalizeProviderId(draft.id)
  if (!id) errors.id = t('providerEditor.errors.id')
  else if (takenIds.includes(id)) errors.id = t('providerEditor.errors.idTaken')

  const parsed = providerConfigSchema.safeParse(toProviderInput(draft))
  if (!parsed.success) {
    for (const issue of parsed.error.issues as z.ZodIssue[]) {
      const field = fieldForPath(issue.path.join('.'))
      if (!errors[field]) errors[field] = messageForField(t, field)
    }
  }
  if (Object.keys(errors).length > 0) return { ok: false, errors }
  if (!parsed.success) {
    return { ok: false, errors: { form: t('providerEditor.errors.generic') } }
  }
  return { ok: true, config: { ...parsed.data, id } }
}

/** Marker value of the "define your own provider" entry in a provider picker. */
export const NEW_PROVIDER_VALUE = '__new_provider__'
