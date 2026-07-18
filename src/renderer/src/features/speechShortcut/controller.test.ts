/**
 * Regression matrix for the speech.toggle command adapter.
 *
 * Export assumptions (Integrator may rename files; keep `./index` barrel stable):
 * - `SPEECH_TOGGLE_ACTION` = `'speech.toggle'`
 * - `SpeechShortcutState` = `'idle' | 'recording' | 'transcribing' | 'review' | 'failed'`
 * - `SpeechShortcutContext` = `{ configured: boolean; state: SpeechShortcutState; toggleRecording(): Promise<void> }`
 * - `SpeechToggleResult` = `'handled' | 'no-active-context' | 'unconfigured' | 'review' | 'busy' | 'stale-context'`
 * - `controller.register(id, context)` → `{ activate(); update(ctx); dispose() }`
 * - `controller.dispatch(SPEECH_TOGGLE_ACTION)` routes only to the last `activate()`d registration
 * - Start/stop share one action: idle → `toggleRecording()` (start); recording/transcribing → same call (stop/abort)
 * - Guards: unconfigured / review / busy (in-flight) / no-active-context / stale-context (dispose/replace)
 * - Optional helper `registerSpeechShortcut(registry, controller)` may exist; this suite does not require it
 *
 * Combined stand: production ships `speechShortcutController.ts` + `index.ts` (path: `speechShortcut/`);
 * the `./index` barrel re-exports the controller contract this suite pins.
 */
import { describe, expect, it, vi } from 'vitest'
import { SPEECH_TOGGLE_ACTION, SpeechShortcutController, type SpeechShortcutContext, type SpeechShortcutState } from './index'

function context(
  toggleRecording = vi.fn(async () => undefined),
  state: SpeechShortcutState = 'idle',
  configured = true
): SpeechShortcutContext {
  return { configured, state, toggleRecording }
}

describe('SpeechShortcutController — start / stop', () => {
  it('starts recording from idle via speech.toggle (handled)', async () => {
    const toggle = vi.fn(async () => undefined)
    const controller = new SpeechShortcutController()
    controller.register('voice-bar', context(toggle, 'idle')).activate()

    await expect(controller.dispatch(SPEECH_TOGGLE_ACTION)).resolves.toBe('handled')
    expect(toggle).toHaveBeenCalledOnce()
  })

  it.each(['recording', 'transcribing'] as const)(
    'stops / aborts from %s via the same speech.toggle action',
    async (state) => {
      const toggle = vi.fn(async () => undefined)
      const controller = new SpeechShortcutController()
      controller.register('voice-bar', context(toggle, state)).activate()

      await expect(controller.dispatch(SPEECH_TOGGLE_ACTION)).resolves.toBe('handled')
      expect(toggle).toHaveBeenCalledOnce()
    }
  )
})

describe('SpeechShortcutController — guards', () => {
  it('returns unconfigured without invoking toggleRecording', async () => {
    const toggle = vi.fn(async () => undefined)
    const controller = new SpeechShortcutController()
    controller.register('voice-bar', context(toggle, 'idle', false)).activate()

    await expect(controller.dispatch(SPEECH_TOGGLE_ACTION)).resolves.toBe('unconfigured')
    expect(toggle).not.toHaveBeenCalled()
  })

  it('returns review without invoking toggleRecording', async () => {
    const toggle = vi.fn(async () => undefined)
    const controller = new SpeechShortcutController()
    controller.register('voice-bar', context(toggle, 'review')).activate()

    await expect(controller.dispatch(SPEECH_TOGGLE_ACTION)).resolves.toBe('review')
    expect(toggle).not.toHaveBeenCalled()
  })

  it('returns busy while a prior toggleRecording is in flight', async () => {
    let finish: (() => void) | undefined
    const toggle = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve
        })
    )
    const controller = new SpeechShortcutController()
    controller.register('voice-bar', context(toggle)).activate()

    const first = controller.dispatch(SPEECH_TOGGLE_ACTION)
    await expect(controller.dispatch(SPEECH_TOGGLE_ACTION)).resolves.toBe('busy')
    expect(toggle).toHaveBeenCalledOnce()
    finish?.()
    await expect(first).resolves.toBe('handled')
  })

  it('returns no-active-context when nothing is activated', async () => {
    const toggle = vi.fn(async () => undefined)
    const controller = new SpeechShortcutController()
    controller.register('voice-bar', context(toggle))

    await expect(controller.dispatch(SPEECH_TOGGLE_ACTION)).resolves.toBe('no-active-context')
    expect(toggle).not.toHaveBeenCalled()
  })
})

describe('SpeechShortcutController — context priority / unmount', () => {
  it('routes only to the last explicitly activated context (priority)', async () => {
    const voiceToggle = vi.fn(async () => undefined)
    const inboxToggle = vi.fn(async () => undefined)
    const controller = new SpeechShortcutController()
    controller.register('voice-bar', context(voiceToggle)).activate()
    controller.register('inbox', context(inboxToggle)).activate()

    await expect(controller.dispatch(SPEECH_TOGGLE_ACTION)).resolves.toBe('handled')
    expect(inboxToggle).toHaveBeenCalledOnce()
    expect(voiceToggle).not.toHaveBeenCalled()
  })

  it('clears activation on dispose (unmount) and does not fall through', async () => {
    const otherToggle = vi.fn(async () => undefined)
    const controller = new SpeechShortcutController()
    controller.register('voice-bar', context(otherToggle))
    const active = controller.register('inbox', context())
    active.activate()
    active.dispose()

    await expect(controller.dispatch(SPEECH_TOGGLE_ACTION)).resolves.toBe('no-active-context')
    expect(otherToggle).not.toHaveBeenCalled()
  })

  it('treats disposed/replaced registrations as stale-context', async () => {
    const staleToggle = vi.fn(async () => undefined)
    const currentToggle = vi.fn(async () => undefined)
    const controller = new SpeechShortcutController()
    const stale = controller.register('inbox', context(staleToggle))
    stale.activate()
    const current = controller.register('inbox', context(currentToggle))
    stale.update(context(staleToggle, 'recording'))
    stale.dispose()

    await expect(controller.dispatch(SPEECH_TOGGLE_ACTION)).resolves.toBe('stale-context')
    current.activate()
    await expect(controller.dispatch(SPEECH_TOGGLE_ACTION)).resolves.toBe('handled')
    expect(staleToggle).not.toHaveBeenCalled()
    expect(currentToggle).toHaveBeenCalledOnce()
  })

  it('honors update() for configured/state transitions without re-registering', async () => {
    const toggle = vi.fn(async () => undefined)
    const controller = new SpeechShortcutController()
    const registration = controller.register('voice-bar', context(toggle, 'idle', false))
    registration.activate()

    await expect(controller.dispatch(SPEECH_TOGGLE_ACTION)).resolves.toBe('unconfigured')
    registration.update(context(toggle, 'idle', true))
    await expect(controller.dispatch(SPEECH_TOGGLE_ACTION)).resolves.toBe('handled')
    registration.update(context(toggle, 'review', true))
    await expect(controller.dispatch(SPEECH_TOGGLE_ACTION)).resolves.toBe('review')
    expect(toggle).toHaveBeenCalledOnce()
  })
})
