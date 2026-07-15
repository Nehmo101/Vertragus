export interface ModelCatalogFilterOptions {
  /** Case-insensitive search. Whitespace-separated terms must all match. */
  query?: string
  /** Model ids hidden by configuration, matched case-insensitively. */
  excludedModels?: readonly string[]
}

function normalized(value: string): string {
  return value.trim().toLocaleLowerCase('en-US')
}

/**
 * Returns a stable subset of a model catalogue. The catalogue and options remain untouched.
 */
export function filterModelCatalog(
  models: readonly string[],
  options: ModelCatalogFilterOptions = {}
): string[] {
  const excluded = new Set((options.excludedModels ?? []).map(normalized).filter(Boolean))
  const terms = normalized(options.query ?? '').split(/\s+/).filter(Boolean)

  return models.filter((model) => {
    const candidate = normalized(model)
    return (
      Boolean(candidate) &&
      !excluded.has(candidate) &&
      terms.every((term) => candidate.includes(term))
    )
  })
}
