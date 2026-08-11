/**
 * Model-id helpers shared by discovery, the settings store and the pickers.
 *
 * There is no hard-coded model catalogue anywhere in Vertragus, so every list
 * that reaches the UI is stitched together from live sources of different
 * quality. These helpers are what make that readable:
 *
 * - Freshness is a property of the id. A rolling ALIAS (`opus`, `sonnet`,
 *   `auto`) resolves to the newest model of its family at launch time; a
 *   versioned id (`claude-opus-5`) pins deliberately. Both belong in the list,
 *   which is why they are grouped by family instead of listed as strangers.
 * - The same model shows up in two spellings across sources
 *   (`claude-sonnet-4.6` vs `claude-sonnet-4-6`) and with dated snapshots
 *   (`…-20250929`). Those fold together for display while every spelling stays
 *   launchable — a CLI may only accept the one it advertised itself.
 *
 * Pure string work, no Node imports.
 */

/**
 * Comparison key folding punctuation spellings of one id together.
 * FOR COMPARISON ONLY — the displayed/committed value keeps its own spelling.
 */
export function normalizeModelKey(model: string): string {
  return model.trim().toLowerCase().replace(/[._]/g, '-')
}

/**
 * Deduplicate model ids across sources; the first spelling seen survives,
 * because that is the one the source that offered it will accept.
 */
export function uniqueModels(values: readonly unknown[]): string[] {
  const seen = new Map<string, string>()
  for (const value of values) {
    if (typeof value !== 'string') continue
    const model = value.trim()
    if (!model) continue
    const key = normalizeModelKey(model)
    if (!seen.has(key)) seen.set(key, model)
  }
  return [...seen.values()]
}

/**
 * True for a rolling alias — an id without a version in it. Claude Code
 * documents `opus`/`sonnet`/`fable` as "alias for the latest model"; Cursor
 * uses `auto` the same way. Anything with a digit is a pinned release.
 */
export function isModelAlias(model: string): boolean {
  const id = model.trim()
  return id.length > 0 && !/\d/.test(id)
}

const SNAPSHOT_SUFFIX = /-20\d{6}$/

/** True for a dated snapshot id like `claude-sonnet-4-5-20250929`. */
export function isSnapshotId(model: string): boolean {
  return SNAPSHOT_SUFFIX.test(model.trim())
}

/** Base id of a dated snapshot (`claude-sonnet-4-5-20250929` → `claude-sonnet-4-5`). */
export function snapshotBase(model: string): string {
  return model.trim().replace(SNAPSHOT_SUFFIX, '')
}

export interface ModelVariant {
  /** Display/commit id — the first spelling the catalogue offered. */
  id: string
  /** Dated snapshots folded into this row; still individually launchable. */
  snapshots: string[]
}

/**
 * Collapse punctuation twins and dated snapshots into display rows. A snapshot
 * folds into its base row when the base exists anywhere in the list; an orphan
 * snapshot (no base offered) stays its own row so it remains launchable.
 * First-seen spelling wins; order of first appearance is preserved.
 */
export function collapseModelVariants(models: readonly string[]): ModelVariant[] {
  const rows: ModelVariant[] = []
  const byKey = new Map<string, ModelVariant>()

  const addRow = (id: string): ModelVariant => {
    const key = normalizeModelKey(id)
    let row = byKey.get(key)
    if (!row) {
      row = { id, snapshots: [] }
      byKey.set(key, row)
      rows.push(row)
    }
    return row
  }

  // Pass 1: every non-snapshot id becomes a row (punctuation twins collapse).
  for (const raw of models) {
    const model = raw.trim()
    if (!model || isSnapshotId(model)) continue
    addRow(model)
  }
  // Pass 2: snapshots fold into their base row or stand alone (rare).
  for (const raw of models) {
    const model = raw.trim()
    if (!model || !isSnapshotId(model)) continue
    const base = byKey.get(normalizeModelKey(snapshotBase(model)))
    if (!base) {
      addRow(model)
      continue
    }
    const known = base.snapshots.some(
      (existing) => normalizeModelKey(existing) === normalizeModelKey(model)
    )
    if (!known) base.snapshots.push(model)
  }
  return rows
}

const VENDOR_PREFIXES = ['claude-', 'anthropic.', 'openai.', 'google.']

/**
 * Family key that groups aliases with their pinned releases: `opus`,
 * `claude-opus-5` and `claude-opus-4-8` all map to `opus`.
 *
 * Strips a vendor prefix, then keeps the segments before the first one carrying
 * a digit (the version). Ids that start with their version (`qwen2.5-coder`)
 * fall back to that first segment so they still group.
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
  const versionAt = segments.findIndex((segment) => /\d/.test(segment))
  const named = segments.slice(0, versionAt < 0 ? segments.length : versionAt)
  return named.length > 0 ? named.join('-') : segments[0]!
}

export interface ModelFamilyGroup {
  /** Grouping key, e.g. `opus`. */
  family: string
  /** The rolling alias of this family, when the catalogue offers one. */
  alias?: string
  /** Pinned releases, in catalogue order. */
  pinned: string[]
}

/**
 * Group a catalogue by model family, alias first. Answers the "why is there
 * both `fable` and `claude-fable-5`?" confusion: same family, one rolling and
 * one pinned. Order of first appearance is kept; duplicates collapse.
 */
export function groupModelsByFamily(models: readonly string[]): ModelFamilyGroup[] {
  const groups: ModelFamilyGroup[] = []
  const byFamily = new Map<string, ModelFamilyGroup>()

  for (const model of uniqueModels(models)) {
    const family = modelFamily(model) || normalizeModelKey(model)
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

export interface ModelVariantFamilyGroup {
  family: string
  alias?: ModelVariant
  pinned: ModelVariant[]
}

/** Family grouping over collapsed variants — what a picker actually renders. */
export function groupModelVariantsByFamily(
  variants: readonly ModelVariant[]
): ModelVariantFamilyGroup[] {
  const groups: ModelVariantFamilyGroup[] = []
  const byFamily = new Map<string, ModelVariantFamilyGroup>()
  for (const variant of variants) {
    const family = modelFamily(variant.id) || normalizeModelKey(variant.id)
    let group = byFamily.get(family)
    if (!group) {
      group = { family, pinned: [] }
      byFamily.set(family, group)
      groups.push(group)
    }
    if (isModelAlias(variant.id) && !group.alias) group.alias = variant
    else group.pinned.push(variant)
  }
  return groups
}

/**
 * Catalogue flattened for a picker: every family's alias directly followed by
 * its pinned releases. Deduplicated, so a merged live+remembered catalogue
 * never shows the same id twice.
 */
export function orderedModelList(models: readonly string[]): string[] {
  return groupModelsByFamily(models).flatMap((group) =>
    group.alias ? [group.alias, ...group.pinned] : group.pinned
  )
}

/**
 * Value the model field must hold after a provider change in the editor.
 *
 * A same-value reselect must KEEP an explicitly chosen model — clearing it
 * would let the CLI default silently override a saved id and persist an empty
 * model. Only a real provider switch clears it, so a stale, incompatible id
 * never carries over. Effort is orthogonal and is preserved separately.
 */
export function modelAfterProviderChange(
  previousProviderId: string,
  nextProviderId: string,
  currentModel: string
): string {
  return previousProviderId === nextProviderId ? currentModel : ''
}
