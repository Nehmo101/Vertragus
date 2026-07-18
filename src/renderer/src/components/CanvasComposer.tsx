import { useRef, useState, type ChangeEvent, type KeyboardEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { useCanvasChatStore } from '../store/canvasChatStore'

interface OrchestratorSendResult { ok: boolean; reason?: 'no_orchestrator' | 'seed_failed' | string }
interface CanvasBridge {
  orchestrator?: { send(profileId: string, sessionId: string | undefined, text: string): Promise<OrchestratorSendResult> }
  voiceOverlay?: { toggle(): Promise<unknown> | void }
}

function canvasBridge(): CanvasBridge {
  return window.vertragus as typeof window.vertragus & CanvasBridge
}

export interface CanvasComposerProps {
  profileId: string
  workspaceSessionId?: string
  orchestratorRunning: boolean
  /** May return the freshly created session id; existing void-returning store actions remain compatible. */
  startAll(): Promise<string | void>
}

export function shouldSubmitComposer(key: string, shiftKey: boolean, composing = false): boolean {
  return key === 'Enter' && !shiftKey && !composing
}

export function CanvasComposer({
  profileId,
  workspaceSessionId,
  orchestratorRunning,
  startAll
}: CanvasComposerProps): JSX.Element {
  const { t } = useTranslation()
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const append = useCanvasChatStore((state) => state.append)
  const setStatus = useCanvasChatStore((state) => state.setStatus)

  const resize = (event: ChangeEvent<HTMLTextAreaElement>): void => {
    event.currentTarget.style.height = 'auto'
    event.currentTarget.style.height = `${Math.min(event.currentTarget.scrollHeight, 144)}px`
    setText(event.currentTarget.value)
  }

  const submit = async (): Promise<void> => {
    const value = text.trim()
    if (!value || busy) return
    const id = globalThis.crypto?.randomUUID?.() ?? `chat-${Date.now()}`
    append({ id, profileId, workspaceSessionId, text: value, createdAt: Date.now(), status: 'sending' })
    setText('')
    setBusy(true)
    if (textareaRef.current) textareaRef.current.style.height = 'auto'
    try {
      const startedSessionId = !orchestratorRunning ? await startAll() : undefined
      const send = canvasBridge().orchestrator?.send
      if (!send) throw new Error('orchestrator.send unavailable')
      const result = await send(profileId, startedSessionId || workspaceSessionId, value)
      setStatus(id, result.ok ? 'sent' : 'failed')
    } catch {
      setStatus(id, 'failed')
    } finally {
      setBusy(false)
    }
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (!shouldSubmitComposer(event.key, event.shiftKey, event.nativeEvent.isComposing)) return
    event.preventDefault()
    void submit()
  }

  return (
    <div className="canvas-composer" data-start-mode={!orchestratorRunning}>
      {!orchestratorRunning && <span className="canvas-composer-mode">{t('canvas.composer.startMode')}</span>}
      <textarea
        ref={textareaRef}
        rows={1}
        value={text}
        aria-label={t('canvas.composer.label')}
        placeholder={t(orchestratorRunning ? 'canvas.composer.placeholder' : 'canvas.composer.startPlaceholder')}
        onChange={resize}
        onKeyDown={onKeyDown}
      />
      <button
        type="button"
        className="canvas-composer-mic"
        aria-label={t('canvas.composer.voice')}
        onClick={() => void canvasBridge().voiceOverlay?.toggle()}
      >◉</button>
      <button
        type="button"
        className="canvas-composer-send"
        aria-label={t('canvas.composer.send')}
        disabled={!text.trim() || busy}
        onClick={() => void submit()}
      >↑</button>
    </div>
  )
}
