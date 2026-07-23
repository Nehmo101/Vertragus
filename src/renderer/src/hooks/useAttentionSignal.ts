/**
 * Pushes the pending-feedback workspace count to the main process via preload.
 * The Integrator wires this hook into App.tsx; do not import it elsewhere yet.
 */
import { useEffect } from 'react'
import { useAppStore } from '@renderer/store/useAppStore'
import { selectPendingFeedbackCount } from '@renderer/store/attentionSelectors'

/** Narrow local bridge — preload API is provided later by the Integrator. */
interface AttentionBridge {
  setPendingFeedbackCount(count: number): void
}

interface VertragusAttentionHost {
  attention?: AttentionBridge
}

/**
 * Subscribes to {@link selectPendingFeedbackCount} and defensively forwards
 * every counter change to `window.vertragus.attention.setPendingFeedbackCount`.
 */
export function useAttentionSignal(): void {
  const count = useAppStore(selectPendingFeedbackCount)

  useEffect(() => {
    const host = (window as unknown as { vertragus?: VertragusAttentionHost }).vertragus
    // Optional-call the method so a partial attention object cannot throw TypeError.
    host?.attention?.setPendingFeedbackCount?.(count)
  }, [count])
}
