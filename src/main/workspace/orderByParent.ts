/**
 * Order a flat agent list so every child follows its parent, recursively.
 *
 * Root children keep start order; a lead's workers sit under the lead; a
 * worker's helpers sit under that worker. Orphans (parent no longer listed)
 * fall to the end rather than disappearing.
 */
export function orderByParent<T extends { agentId: string }>(
  agents: readonly T[],
  parentOf: (agent: T) => string | undefined
): T[] {
  const byParent = new Map<string | undefined, T[]>()
  for (const agent of agents) {
    const key = parentOf(agent)
    const bucket = byParent.get(key) ?? []
    bucket.push(agent)
    byParent.set(key, bucket)
  }
  const ordered: T[] = []
  const seen = new Set<string>()
  const walk = (parentId: string | undefined): void => {
    for (const child of byParent.get(parentId) ?? []) {
      if (seen.has(child.agentId)) continue
      ordered.push(child)
      seen.add(child.agentId)
      walk(child.agentId)
    }
  }
  walk(undefined)
  for (const agent of agents) if (!seen.has(agent.agentId)) ordered.push(agent)
  return ordered
}
