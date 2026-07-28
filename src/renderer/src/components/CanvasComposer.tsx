import { useRef, useState, type ChangeEvent, type KeyboardEvent } from 'react'
import { useTranslation } from 'react-i18next'
import type { GithubIssueSummary } from '@shared/ipc'
import { useCanvasChatStore } from '../store/canvasChatStore'
import { useAppStore } from '../store/useAppStore'
import IssuePickerModal, { IssueGlyph } from './github/IssuePickerModal'
import { formatIssueGoal } from './github/issueGoal'
import issueStyles from './github/IssuePicker.module.css'

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
  const [issuePickerOpen, setIssuePickerOpen] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const append = useCanvasChatStore((state) => state.append)
  const setStatus = useCanvasChatStore((state) => state.setStatus)
  // Bound GitHub repo of the active profile — gates the issue picker trigger.
  const githubRepo = useAppStore(
    (state) => state.profiles.find((profile) => profile.id === profileId)?.githubRepo
  )
  const repoBound = Boolean(githubRepo?.owner && githubRepo?.repo)

  const insertIssueGoal = (issue: GithubIssueSummary): void => {
    setIssuePickerOpen(false)
    // Draft only — the user reviews/edits and sends the goal themselves.
    setText(formatIssueGoal(issue))
    requestAnimationFrame(() => {
      const textarea = textareaRef.current
      if (!textarea) return
      textarea.style.height = 'auto'
      textarea.style.height = `${Math.min(textarea.scrollHeight, 144)}px`
      textarea.focus()
    })
  }

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
      {repoBound && (
        <button
          type="button"
          className={issueStyles.trigger}
          title={t('issues.triggerTitle')}
          onClick={() => setIssuePickerOpen(true)}
        >
          <span className={issueStyles.triggerGlyph}>
            <IssueGlyph />
          </span>
          {t('issues.trigger')}
        </button>
      )}
      {issuePickerOpen && githubRepo && (
        <IssuePickerModal
          owner={githubRepo.owner}
          repo={githubRepo.repo}
          onSelect={insertIssueGoal}
          onClose={() => setIssuePickerOpen(false)}
        />
      )}
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
