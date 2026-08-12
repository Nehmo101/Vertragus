/**
 * Quantitative routing signal derived from persisted run retros.
 *
 * Turns the per-run RoleModelStats into an aggregated success track record per
 * provider × model, scored with the Wilson lower bound so few-sample models are
 * ranked conservatively. Pure and deterministic — the result lands in the
 * orchestrator system prompt next to the qualitative learning texts.
 */
import type { RunRetro } from '../schema/retro'

/** Below this many judged tasks a model has no routing score at all. */
export const MIN_ROUTING_SAMPLES = 3

export interface RoutingScore {
  providerId: string
  /** Resolved model name; empty string = provider CLI default. */
  model: string
  /** Roles the samples were observed in (aggregated, informational). */
  roles: string[]
  /** Judged terminal outcomes: success + blocked + failed. Stopped and unconfirmed exits excluded. */
  samples: number
  successRate: number
  blockedRate: number
  /** Wilson lower bound (95%) of the success rate — conservative ranking key. */
  score: number
}

/** Wilson score interval lower bound for a Bernoulli proportion (z = 1.96). */
export function wilsonLowerBound(successes: number, samples: number): number {
  if (samples <= 0) return 0
  const z = 1.96
  const p = successes / samples
  const z2 = z * z
  const denominator = 1 + z2 / samples
  const centre = p + z2 / (2 * samples)
  const margin = z * Math.sqrt((p * (1 - p) + z2 / (4 * samples)) / samples)
  return Math.max(0, (centre - margin) / denominator)
}

const keyOf = (providerId: string, model: string): string => `${providerId} ${model}`

export function computeRoutingScores(retros: readonly RunRetro[]): RoutingScore[] {
  const aggregate = new Map<
    string,
    {
      providerId: string
      model: string
      roles: Set<string>
      succeeded: number
      blocked: number
      failed: number
    }
  >()
  for (const retro of retros) {
    for (const stats of retro.stats) {
      const key = keyOf(stats.providerId, stats.model)
      const entry = aggregate.get(key) ?? {
        providerId: stats.providerId,
        model: stats.model,
        roles: new Set<string>(),
        succeeded: 0,
        blocked: 0,
        failed: 0
      }
      entry.roles.add(stats.roleId)
      entry.succeeded += stats.succeeded
      entry.blocked += stats.blocked
      entry.failed += stats.failed
      aggregate.set(key, entry)
    }
  }
  return [...aggregate.values()]
    .map((entry) => {
      const samples = entry.succeeded + entry.blocked + entry.failed
      return {
        providerId: entry.providerId,
        model: entry.model,
        roles: [...entry.roles].sort(),
        samples,
        successRate: samples > 0 ? entry.succeeded / samples : 0,
        blockedRate: samples > 0 ? entry.blocked / samples : 0,
        score: wilsonLowerBound(entry.succeeded, samples)
      }
    })
    .filter((entry) => entry.samples > 0)
    .sort((a, b) => b.score - a.score)
}

/**
 * Routing score for one provider/model — undefined below the sample floor, so
 * callers never rank on statistical noise.
 */
export function routingScoreFor(
  scores: readonly RoutingScore[],
  providerId: string,
  model: string
): RoutingScore | undefined {
  const match = scores.find((entry) => entry.providerId === providerId && entry.model === model)
  return match && match.samples >= MIN_ROUTING_SAMPLES ? match : undefined
}
