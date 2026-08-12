/**
 * Fold a workspace's event stream into per role+model tallies, and shape the
 * accumulated knowledge (learnings + routing scores) for the orchestrator
 * prompt. Pure over `AgentEvent[]` — the main process taps the EventQueue and
 * hands the collected array in at workspace stop.
 *
 * Counting semantics: every `agent_done` is one judged sample — an agent that
 * reports twice (follow-up task via send_to_agent) contributes two samples.
 * That differs from the old repo's task-graph counting on purpose: judged
 * outcomes are what the orchestrator actually saw. Providers without an MCP
 * reporting path (mcp.kind 'none', e.g. Cursor) never emit `agent_done`, so
 * they collect started/unconfirmedExits/stopped only and never earn a routing
 * score — no evidence, no score.
 */
import type { AgentEvent } from '../schema/events'
import type { Slot } from '../schema/profile'
import type { ModelLearning, RoleModelStats } from '../schema/retro'
import { selectLearningTexts } from './learnings'
import { routingScoreFor, type RoutingScore } from './routingStats'

interface AgentIdentity {
  roleId: string
  providerId: string
  model: string
}

export function deriveRoleModelStats(events: readonly AgentEvent[]): RoleModelStats[] {
  const identities = new Map<string, AgentIdentity>()
  const stats = new Map<string, RoleModelStats>()

  const statsFor = (identity: AgentIdentity): RoleModelStats => {
    const key = `${identity.roleId}|${identity.providerId}|${identity.model}`
    const existing = stats.get(key)
    if (existing) return existing
    const created: RoleModelStats = {
      roleId: identity.roleId,
      providerId: identity.providerId,
      model: identity.model,
      started: 0,
      succeeded: 0,
      blocked: 0,
      failed: 0,
      unconfirmedExits: 0,
      stopped: 0
    }
    stats.set(key, created)
    return created
  }

  const identityOf = (event: AgentEvent): AgentIdentity =>
    identities.get(event.agentId) ?? { roleId: event.roleId, providerId: '', model: '' }

  for (const event of events) {
    switch (event.type) {
      case 'agent_started': {
        const identity: AgentIdentity = {
          roleId: event.roleId,
          providerId: event.providerId ?? '',
          model: event.model ?? ''
        }
        identities.set(event.agentId, identity)
        statsFor(identity).started += 1
        break
      }
      case 'agent_done': {
        const row = statsFor(identityOf(event))
        if (event.status === 'success') row.succeeded += 1
        else if (event.status === 'blocked') row.blocked += 1
        else row.failed += 1
        break
      }
      case 'agent_exited': {
        // A confirmed exit was already counted by its agent_done.
        if (!event.confirmed) statsFor(identityOf(event)).unconfirmedExits += 1
        break
      }
      case 'agent_stopped': {
        statsFor(identityOf(event)).stopped += 1
        break
      }
      default:
        break
    }
  }

  return [...stats.values()]
}

export interface SlotKnowledge {
  roleId: string
  providerId: string
  /** Resolved model name; empty string = provider CLI default. */
  model: string
  score?: Pick<RoutingScore, 'samples' | 'successRate' | 'score'>
  strengths: string[]
  weaknesses: string[]
}

/** Insights per slot are capped so the prompt block stays small enough to seed via PTY. */
const MAX_INSIGHTS_PER_SLOT = 3

/**
 * The per-slot knowledge block the orchestrator prompt renders. Slots without
 * any evidence (no score above the sample floor, no learnings) are omitted.
 */
export function knowledgeForSlots(
  slots: readonly Pick<Slot, 'roleId' | 'providerId' | 'model'>[],
  learnings: readonly ModelLearning[],
  scores: readonly RoutingScore[]
): SlotKnowledge[] {
  const knowledge: SlotKnowledge[] = []
  const seen = new Set<string>()
  for (const slot of slots) {
    const model = slot.model?.trim() ?? ''
    const key = `${slot.roleId}|${slot.providerId}|${model}`
    if (seen.has(key)) continue
    seen.add(key)
    const score = routingScoreFor(scores, slot.providerId, model)
    const texts = selectLearningTexts(learnings, slot.providerId, model, MAX_INSIGHTS_PER_SLOT)
    if (!score && texts.strengths.length === 0 && texts.weaknesses.length === 0) continue
    knowledge.push({
      roleId: slot.roleId,
      providerId: slot.providerId,
      model,
      ...(score
        ? { score: { samples: score.samples, successRate: score.successRate, score: score.score } }
        : {}),
      strengths: texts.strengths,
      weaknesses: texts.weaknesses
    })
  }
  return knowledge
}
