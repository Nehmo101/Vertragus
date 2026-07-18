import { createContext, useContext, useEffect, useMemo, useRef, type ReactNode } from 'react'
import {
  DEFAULT_SHORTCUT_BINDINGS,
  ShortcutRegistry,
  detectShortcutPlatform,
  normalizeBinding,
  type ShortcutPlatform
} from '../../shortcuts'
import {
  SPEECH_TOGGLE_ACTION,
  SpeechShortcutController,
  registerSpeechShortcut,
  type SpeechShortcutContext,
  type SpeechShortcutRegistration
} from './speechShortcutController'

interface SpeechShortcutApi {
  controller: SpeechShortcutController
  registry: ShortcutRegistry
  platform: ShortcutPlatform
}

const SpeechShortcutReactContext = createContext<SpeechShortcutApi | null>(null)

/**
 * App-lifecycle owner of the single shared ShortcutRegistry + SpeechShortcutController.
 *
 * Wiring only — no OS-level globalShortcut and no new IPC boundary. The registry listens on
 * the renderer `window` keydown; the `speech.toggle` action routes through the controller to
 * whichever VoiceBar/Inbox context is currently active, so Ctrl/Cmd+Shift+M starts/stops the
 * recording exactly once in the active context.
 */
export function SpeechShortcutProvider({
  children,
  target
}: {
  children: ReactNode
  /** Injectable listener target for tests; defaults to the renderer window. */
  target?: Pick<EventTarget, 'addEventListener' | 'removeEventListener'>
}): JSX.Element {
  const api = useMemo<SpeechShortcutApi>(() => {
    const platform = detectShortcutPlatform()
    return {
      platform,
      controller: new SpeechShortcutController(),
      registry: new ShortcutRegistry({ platform })
    }
  }, [])

  useEffect(() => {
    const listenerTarget = target ?? window
    const unregister = registerSpeechShortcut(api.registry, api.controller)
    const detach = api.registry.attach(listenerTarget)
    return () => {
      detach()
      unregister()
    }
  }, [api, target])

  return (
    <SpeechShortcutReactContext.Provider value={api}>{children}</SpeechShortcutReactContext.Provider>
  )
}

/**
 * Register a speech context (e.g. `'voice-bar'`, `'inbox'`) for the lifetime of the calling
 * component. The latest `context` is pushed to the controller on every change (state/configured/
 * toggleRecording), the registration activates while `active` is true, and it is disposed on
 * unmount — covering the recording/transcribing/review/unconfigured and unmount/stale-handler paths.
 */
export function useSpeechShortcutContext(
  id: string,
  context: SpeechShortcutContext,
  active = true
): void {
  const api = useContext(SpeechShortcutReactContext)
  const registrationRef = useRef<SpeechShortcutRegistration | null>(null)

  useEffect(() => {
    if (!api) return undefined
    const registration = api.controller.register(id, context)
    registrationRef.current = registration
    return () => {
      registration.dispose()
      registrationRef.current = null
    }
    // Register once per controller/id; live values flow through the update effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, id])

  useEffect(() => {
    registrationRef.current?.update(context)
    // Push the individual live fields; `context` is a fresh object on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [context.configured, context.state, context.toggleRecording])

  useEffect(() => {
    if (active) registrationRef.current?.activate()
  }, [active, api, id])
}

const MAC_MODIFIER_SYMBOLS: Readonly<Record<string, string>> = {
  Control: '⌃',
  Meta: '⌘',
  Alt: '⌥',
  Shift: '⇧'
}

const OTHER_MODIFIER_LABELS: Readonly<Record<string, string>> = {
  Control: 'Ctrl',
  Meta: 'Win',
  Alt: 'Alt',
  Shift: 'Shift'
}

/**
 * Platform-appropriate display of the speech.toggle chord derived from the real binding:
 * `⌘⇧M` on macOS, `Ctrl+Shift+M` elsewhere. Language-neutral by design — the surrounding
 * DE/EN copy lives in i18n and interpolates this value.
 */
export function speechShortcutKeys(platform: ShortcutPlatform = detectShortcutPlatform()): string {
  const binding = DEFAULT_SHORTCUT_BINDINGS[SPEECH_TOGGLE_ACTION]?.[0]
  if (!binding) return ''
  const tokens = normalizeBinding(binding, platform).split('+')
  const key = (tokens.pop() ?? '').toUpperCase()
  if (platform === 'mac') {
    return tokens.map((token) => MAC_MODIFIER_SYMBOLS[token] ?? token).join('') + key
  }
  return [...tokens.map((token) => OTHER_MODIFIER_LABELS[token] ?? token), key].join('+')
}

/**
 * The same chord in the W3C `aria-keyshortcuts` token format (e.g. `Control+Shift+M`,
 * `Meta+Shift+M`) — assistive-tech readable and platform-correct.
 */
export function speechShortcutAriaKeys(
  platform: ShortcutPlatform = detectShortcutPlatform()
): string {
  const binding = DEFAULT_SHORTCUT_BINDINGS[SPEECH_TOGGLE_ACTION]?.[0]
  if (!binding) return ''
  const tokens = normalizeBinding(binding, platform).split('+')
  const key = (tokens.pop() ?? '').toUpperCase()
  return [...tokens, key].join('+')
}
