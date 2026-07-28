import type { ModelLearning } from '@shared/retro'
import { learningKey, selectLearningTexts } from '@shared/retro'
import { resolveModel, type ModelSelection } from '@shared/models'
import type { AgentProviderId } from '@shared/providers'

/**
 * Minimal structural view of a configured subagent slot — exactly the fields
 * the routing insight derivation reads from `profile.agents`.
 */
export interface RoutingSlot extends ModelSelection {
  role: string
  provider: AgentProviderId
  /** Only orchestrated slots receive dispatched tasks; others are skipped. */
  orchestrated?: boolean
}

/** Accumulated learned strengths/weaknesses for one configured provider/model. */
export interface RoutingInsight {
  provider: AgentProviderId
  /** Resolved model name; empty string = provider CLI default. */
  model: string
  /** Roles of the profile slots running this model. */
  roles: string[]
  learnedStrengths: string[]
  learnedWeaknesses: string[]
}

/**
 * "Warum dieses Modell?" — derives, per configured subagent slot, the learned
 * strengths/weaknesses the adaptive router sees for that provider/model. Uses
 * the same selection helper as the engine's SubagentDescriptor projection, so
 * the panel shows exactly the knowledge that steers routing. Learnings may
 * arrive twice (persisted store + last run retro); duplicates are merged by
 * their stable learning key, keeping the better-confirmed entry.
 */
export function buildRoutingInsights(
  slots: readonly RoutingSlot[] | undefined,
  learnings: readonly ModelLearning[],
  limit = 4
): RoutingInsight[] {
  if (!slots || slots.length === 0 || learnings.length === 0) return []

  const byKey = new Map<string, ModelLearning>()
  for (const learning of learnings) {
    const key = learningKey(learning)
    const current = byKey.get(key)
    if (
      !current ||
      learning.observations > current.observations ||
      (learning.observations === current.observations && learning.updatedAt > current.updatedAt)
    ) {
      byKey.set(key, learning)
    }
  }
  const deduped = [...byKey.values()]

  const groups = new Map<string, { provider: AgentProviderId; model: string; roles: string[] }>()
  for (const slot of slots) {
    if (slot.orchestrated === false) continue
    const model = resolveModel(slot.provider, slot)
    const groupKey = `${slot.provider}|${model.trim().toLowerCase()}`
    const group = groups.get(groupKey) ?? { provider: slot.provider, model, roles: [] }
    if (!group.roles.includes(slot.role)) group.roles.push(slot.role)
    groups.set(groupKey, group)
  }

  const insights: RoutingInsight[] = []
  for (const group of groups.values()) {
    const texts = selectLearningTexts(deduped, group.provider, group.model, limit)
    if (texts.strengths.length === 0 && texts.weaknesses.length === 0) continue
    insights.push({
      provider: group.provider,
      model: group.model,
      roles: group.roles,
      learnedStrengths: texts.strengths,
      learnedWeaknesses: texts.weaknesses
    })
  }
  return insights
}
