import type { ShortcutRegistry } from '../../shortcuts'

export const SPEECH_TOGGLE_ACTION = 'speech.toggle' as const

export type SpeechShortcutAction = typeof SPEECH_TOGGLE_ACTION
export type SpeechShortcutState = 'idle' | 'recording' | 'transcribing' | 'review' | 'failed'

export interface SpeechShortcutContext {
  configured: boolean
  state: SpeechShortcutState
  toggleRecording: () => Promise<void>
}

export type SpeechToggleResult =
  | 'handled'
  | 'no-active-context'
  | 'unconfigured'
  | 'review'
  | 'busy'
  | 'stale-context'

export interface SpeechShortcutRegistration {
  activate(): void
  update(context: SpeechShortcutContext): void
  dispose(): void
}

interface RegisteredContext {
  generation: symbol
  current: SpeechShortcutContext
}

export class SpeechShortcutController {
  private readonly contexts = new Map<string, RegisteredContext>()
  private active: { id: string; generation: symbol } | undefined
  private dispatching = false

  register(id: string, context: SpeechShortcutContext): SpeechShortcutRegistration {
    const generation = Symbol(id)
    this.contexts.set(id, { generation, current: context })

    return {
      activate: () => {
        if (this.isCurrent(id, generation)) this.active = { id, generation }
      },
      update: (next) => {
        const registered = this.contexts.get(id)
        if (registered?.generation === generation) registered.current = next
      },
      dispose: () => {
        if (!this.isCurrent(id, generation)) return
        this.contexts.delete(id)
        if (this.active?.id === id && this.active.generation === generation) {
          this.active = undefined
        }
      }
    }
  }

  async dispatch(action: SpeechShortcutAction): Promise<SpeechToggleResult> {
    if (action !== SPEECH_TOGGLE_ACTION) return 'no-active-context'
    if (this.dispatching) return 'busy'

    const selected = this.active
    if (!selected) return 'no-active-context'
    const registered = this.contexts.get(selected.id)
    if (!registered || registered.generation !== selected.generation) return 'stale-context'

    const context = registered.current
    if (!context.configured) return 'unconfigured'
    if (context.state === 'review') return 'review'

    this.dispatching = true
    try {
      if (!this.isCurrent(selected.id, selected.generation)) return 'stale-context'
      await context.toggleRecording()
      return 'handled'
    } finally {
      this.dispatching = false
    }
  }

  private isCurrent(id: string, generation: symbol): boolean {
    return this.contexts.get(id)?.generation === generation
  }
}

export function registerSpeechShortcut(
  registry: ShortcutRegistry,
  controller: SpeechShortcutController
): () => void {
  return registry.register({
    actionId: SPEECH_TOGGLE_ACTION,
    handler: () => {
      void controller.dispatch(SPEECH_TOGGLE_ACTION)
    }
  })
}
