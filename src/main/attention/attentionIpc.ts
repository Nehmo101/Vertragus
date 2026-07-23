import {
  assertAuthorizedRendererIpcSender,
  type RendererIpcAuthorizationOptions,
  type RendererIpcEventLike
} from '@main/security/ipcAuthorization'
import { setPendingFeedbackCount as applyPendingFeedbackCount } from '@main/attention/attentionService'

/** Hard ceiling so a runaway renderer cannot inflate attention state unboundedly. */
export const ATTENTION_COUNT_MAX = 10_000

export interface AttentionIpcDependencies {
  authorization: RendererIpcAuthorizationOptions
  setPendingFeedbackCount?(count: number): void
}

/**
 * Parse and clamp a pending-feedback count from a one-way IPC payload.
 * Rejects non-numbers, non-finite values and non-integers; clamps to [0, 10000].
 */
export function parsePendingFeedbackCount(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)) {
    throw new Error('Ungültiger Attention-Count (invalid payload).')
  }
  if (value < 0) return 0
  if (value > ATTENTION_COUNT_MAX) return ATTENTION_COUNT_MAX
  return value
}

/** Authorize + validate before mutating the attention state machine. */
export function createAttentionIpcController(dependencies: AttentionIpcDependencies): {
  setPendingFeedbackCount(event: RendererIpcEventLike, count: unknown): void
} {
  const apply = dependencies.setPendingFeedbackCount ?? applyPendingFeedbackCount

  return {
    setPendingFeedbackCount(event, count) {
      assertAuthorizedRendererIpcSender(
        event,
        dependencies.authorization,
        'Attention-IPC: Zugriff verweigert (unauthorized).'
      )
      apply(parsePendingFeedbackCount(count))
    }
  }
}
