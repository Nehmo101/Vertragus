/**
 * Model selection helpers.
 *
 * Resolution is deliberately simple: the `model` field wins, and an empty field
 * means "provider CLI default". There is no model-tier preset any more —
 * fast/balanced/strong only ever expanded to a model id, so it duplicated the
 * model field and went stale with every model release. The performance knob is
 * now `effort` (see ./effort.ts), which is orthogonal to the model.
 *
 * Freshness is a property of the id itself: a provider ALIAS (`opus`, `sonnet`,
 * `haiku`, `fable`, `auto`) always resolves to the newest model of that family
 * at launch time, so a profile pinned to an alias picks up new releases without
 * anyone editing a list. A versioned id (`claude-opus-5`) pins deliberately.
 * That is also why both forms show up in the picker — grouping them by family
 * (see groupModelsByFamily) is what keeps the list readable.
 */
import type { AgentProviderId } from './providers'

export interface ModelSelection {
  model?: string
}

/** Resolve the model id passed to provider CLIs as --model (or codex -c model=). */
export function resolveModel(_provider: AgentProviderId, sel: ModelSelection): string {
  return sel.model?.trim() ?? ''
}

/**
 * Value the model field must hold after a provider `<select>` change.
 *
 * A same-value reselect (or any onChange where the provider is unchanged) must
 * keep an explicitly chosen model — clearing it would let the CLI default
 * silently override a saved id and persist an empty `model` to the store. Only a
 * real provider switch clears the field so a stale, incompatible id never carries
 * over; `effort` is handled separately and is intentionally preserved.
 */
export function modelAfterProviderChange(
  prev: AgentProviderId,
  next: AgentProviderId,
  currentModel: string
): string {
  return prev === next ? currentModel : ''
}

/** UI label for the effective model (resolved or CLI default). */
export function formatModelLabel(resolved: string): string {
  return resolved || 'CLI-Standard'
}

/**
 * True for a rolling alias — an id without a version in it. Claude Code
 * documents `opus`/`sonnet`/`fable` as "alias for the latest model", Cursor and
 * Copilot use `auto` the same way. Everything with a digit is a pinned release
 * (`claude-opus-5`, `gpt-5.6-sol`, `qwen2.5-coder:32b`).
 */
export function isModelAlias(model: string): boolean {
  const id = model.trim()
  return id.length > 0 && !/\d/.test(id)
}

const VENDOR_PREFIXES = ['claude-', 'anthropic.', 'openai.', 'google.']

/**
 * Family key used to group aliases with their pinned releases:
 * `opus`, `claude-opus-5` and `claude-opus-4-8` all map to `opus`.
 *
 * Strips a vendor prefix, then keeps the segments before the first one that
 * carries a digit (the version). Ids that start with their version
 * (`qwen2.5-coder`) fall back to that first segment so they still group.
 */
export function modelFamily(model: string): string {
  let id = model.trim().toLowerCase()
  if (!id) return ''
  for (const prefix of VENDOR_PREFIXES) {
    if (id.startsWith(prefix)) {
      id = id.slice(prefix.length)
      break
    }
  }
  const segments = id.split(/[-_:.]/).filter(Boolean)
  if (segments.length === 0) return id
  const named = segments.slice(0, segments.findIndex((segment) => /\d/.test(segment)))
  return named.length > 0 ? named.join('-') : segments[0]!
}

export interface ModelFamilyGroup {
  /** Grouping key, e.g. `opus`. */
  family: string
  /** The rolling alias of this family, when the catalogue offers one. */
  alias?: string
  /** Pinned releases, in catalogue order (newest first for curated lists). */
  pinned: string[]
}

/**
 * Group a provider catalogue by model family, alias first.
 *
 * Answers the "why is there both `fable` and `claude-fable-5`?" confusion: they
 * are the same family — one rolling, one pinned — and the picker shows them as
 * one block instead of two unrelated rows. Order of first appearance is kept so
 * a provider's own ranking survives; duplicates (case-insensitive) collapse.
 */
export function groupModelsByFamily(models: readonly string[]): ModelFamilyGroup[] {
  const groups: ModelFamilyGroup[] = []
  const byFamily = new Map<string, ModelFamilyGroup>()
  const seen = new Set<string>()

  for (const raw of models) {
    const model = raw.trim()
    if (!model) continue
    const key = model.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)

    const family = modelFamily(model) || key
    let group = byFamily.get(family)
    if (!group) {
      group = { family, pinned: [] }
      byFamily.set(family, group)
      groups.push(group)
    }
    if (isModelAlias(model) && !group.alias) group.alias = model
    else group.pinned.push(model)
  }

  return groups
}

/**
 * Catalogue flattened for a picker: every family's alias directly followed by
 * its pinned releases. Deduplicated, so a merged live+curated catalogue no
 * longer shows the same id twice.
 */
export function orderedModelList(models: readonly string[]): string[] {
  return groupModelsByFamily(models).flatMap((group) =>
    group.alias ? [group.alias, ...group.pinned] : group.pinned
  )
}
