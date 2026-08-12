/**
 * The impure edge of the retro loop: where learnings and finished runs land in
 * the settings store, and where the accumulated knowledge comes back out for
 * the next orchestrator prompt.
 *
 * Everything analytical is imported from `@shared/retro/*` — this module only
 * resolves roles to providers via the profile and talks to the store. The
 * store is injected as a narrow port so the whole sink is unit-testable
 * without Electron, mirroring how `appIpc` treats the settings store.
 */
import type { AgentEvent } from '@shared/schema/events'
import type { Profile } from '@shared/schema/profile'
import type { ModelLearning, NewModelLearning, RunRetro } from '@shared/schema/retro'
import { mergeModelLearnings } from '@shared/retro/learnings'
import { computeRoutingScores } from '@shared/retro/routingStats'
import { deriveRoleModelStats, knowledgeForSlots, type SlotKnowledge } from '@shared/retro/runStats'
import type { RetroLearningInput } from '@main/mcp/types'

/** The slice of the settings store the sink needs. */
export interface RetroStorePort {
  getRunRetros(): RunRetro[]
  recordRunRetro(retro: unknown): RunRetro[]
  getModelLearnings(): ModelLearning[]
  setModelLearnings(learnings: readonly unknown[]): ModelLearning[]
}

export interface RetroSinkDeps {
  store: RetroStorePort
  now?: () => number
}

export interface FinalizeRunInput {
  workspaceId: string
  workspaceName: string
  profileId: string
  events: readonly AgentEvent[]
  /** The orchestrator's record_retro verdict, when it gave one. */
  summary?: string
}

export interface RetroSink {
  /** Merge role-keyed learnings into the store; unknown roles are skipped. */
  recordLearnings(profile: Profile, learnings: readonly RetroLearningInput[]): { applied: number }
  /**
   * Persist the run's tallies. Runs that never started an agent are skipped —
   * an orchestrator that only looked around is noise, not evidence.
   */
  finalizeRun(input: FinalizeRunInput): RunRetro | undefined
  /** The per-slot knowledge block for the orchestrator prompt. */
  knowledge(profile: Profile): SlotKnowledge[]
}

export function createRetroSink({ store, now = Date.now }: RetroSinkDeps): RetroSink {
  return {
    recordLearnings(profile, learnings) {
      const additions: NewModelLearning[] = []
      for (const entry of learnings) {
        // Same resolution rule as Workspace.slotFor: the first slot of the
        // role. Exact enough — the model override, when one was used, arrives
        // via `entry.model`.
        const slot = profile.slots.find((candidate) => candidate.roleId === entry.role)
        if (!slot) continue
        additions.push({
          providerId: slot.providerId,
          model: entry.model?.trim() ?? slot.model?.trim() ?? '',
          roleId: entry.role,
          kind: entry.kind,
          insight: entry.insight,
          evidence: entry.evidence,
          source: 'orchestrator',
          profileId: profile.id
        })
      }
      if (additions.length === 0) return { applied: 0 }
      const merged = mergeModelLearnings(store.getModelLearnings(), additions, now())
      store.setModelLearnings(merged.all)
      return { applied: merged.applied.length }
    },

    finalizeRun(input) {
      const stats = deriveRoleModelStats(input.events)
      if (!input.events.some((event) => event.type === 'agent_started')) return undefined
      const retro: RunRetro = {
        id: `retro-${input.workspaceId}`,
        workspaceId: input.workspaceId,
        workspaceName: input.workspaceName,
        profileId: input.profileId,
        summary: input.summary?.trim() ?? '',
        stats,
        createdAt: input.events[0]?.ts ?? now(),
        endedAt: now()
      }
      store.recordRunRetro(retro)
      return retro
    },

    knowledge(profile) {
      const learnings = store.getModelLearnings()
      const scores = computeRoutingScores(store.getRunRetros())
      return knowledgeForSlots(profile.slots, learnings, scores)
    }
  }
}
