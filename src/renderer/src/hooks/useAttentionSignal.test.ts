import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * useAttentionSignal is a thin React hook (useAppStore + useEffect).
 * This project has no @testing-library/react and vitest runs in `environment: 'node'`,
 * so we exercise the effect-core as a pure forwarder that mirrors the hook body:
 *
 *   const host = (window as …).vertragus
 *   host?.attention?.setPendingFeedbackCount?.(count)
 */
function pushPendingFeedbackCount(count: number): void {
  const host = (
    globalThis as unknown as {
      vertragus?: { attention?: { setPendingFeedbackCount?(next: number): void } }
    }
  ).vertragus
  host?.attention?.setPendingFeedbackCount?.(count)
}

describe('useAttentionSignal effect-core', () => {
  afterEach(() => {
    delete (globalThis as { vertragus?: unknown }).vertragus
  })

  it('does not throw when window.vertragus.attention is missing or incomplete', () => {
    delete (globalThis as { vertragus?: unknown }).vertragus
    expect(() => pushPendingFeedbackCount(3)).not.toThrow()

    ;(globalThis as { vertragus?: object }).vertragus = {}
    expect(() => pushPendingFeedbackCount(3)).not.toThrow()

    ;(globalThis as { vertragus?: object }).vertragus = { attention: {} }
    expect(() => pushPendingFeedbackCount(3)).not.toThrow()
  })

  it('calls setPendingFeedbackCount with the new count on change', () => {
    const setPendingFeedbackCount = vi.fn()
    ;(globalThis as {
      vertragus?: { attention?: { setPendingFeedbackCount: typeof setPendingFeedbackCount } }
    }).vertragus = { attention: { setPendingFeedbackCount } }

    pushPendingFeedbackCount(0)
    pushPendingFeedbackCount(2)

    expect(setPendingFeedbackCount).toHaveBeenCalledTimes(2)
    expect(setPendingFeedbackCount).toHaveBeenNthCalledWith(1, 0)
    expect(setPendingFeedbackCount).toHaveBeenNthCalledWith(2, 2)
  })

  it('keeps the hook body defensively optional-chained (source contract)', async () => {
    const source = await import('./useAttentionSignal?raw').then(
      (module) => module.default as string
    )
    expect(source).toMatch(/host\?\.attention\?\.setPendingFeedbackCount\?\.\(count\)/)
    expect(source).not.toMatch(/Authorization|Bearer|process\.env/)
  })
})
