import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useVoiceAssistant } from '@renderer/hooks/useVoiceAssistant'
import '@renderer/assets/voice-overlay.css'

interface DragStart {
  pointerX: number
  pointerY: number
  windowX: number
  windowY: number
  moved: boolean
}

export default function VoiceOverlay(): JSX.Element {
  const { t } = useTranslation()
  const assistant = useVoiceAssistant()
  const [expanded, setExpanded] = useState(false)
  const [text, setText] = useState('')
  const dragRef = useRef<DragStart | null>(null)

  const submit = (): void => {
    const value = text.trim()
    if (!value) return
    setText('')
    setExpanded(true)
    void assistant.submitText(value)
  }

  const beginDrag = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return
    dragRef.current = {
      pointerX: event.screenX,
      pointerY: event.screenY,
      windowX: window.screenX,
      windowY: window.screenY,
      moved: false
    }
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  const drag = (event: React.PointerEvent<HTMLDivElement>): void => {
    const start = dragRef.current
    if (!start) return
    const dx = event.screenX - start.pointerX
    const dy = event.screenY - start.pointerY
    if (Math.abs(dx) + Math.abs(dy) < 4) return
    start.moved = true
    assistant.reportMoved(Math.round(start.windowX + dx), Math.round(start.windowY + dy))
  }

  const endDrag = (event: React.PointerEvent<HTMLDivElement>): void => {
    const moved = dragRef.current?.moved ?? false
    dragRef.current = null
    if (!moved) {
      setExpanded(true)
      void assistant.toggleRecording()
    }
    event.currentTarget.releasePointerCapture(event.pointerId)
  }

  const busy = assistant.state === 'thinking' || assistant.state === 'speaking'

  return (
    <main className={`voice-overlay state-${assistant.state} ${expanded ? 'expanded' : ''}`}>
      <div
        className="voice-orb drag-region"
        role="button"
        tabIndex={0}
        aria-label={t('voiceOverlay.toggle')}
        aria-pressed={assistant.state === 'listening'}
        onPointerDown={beginDrag}
        onPointerMove={drag}
        onPointerUp={endDrag}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            setExpanded(true)
            void assistant.toggleRecording()
          }
        }}
      >
        <span className="voice-orb-core">◆</span>
        {assistant.state === 'listening' && <span className="vwave" aria-hidden="true"><i /><i /><i /><i /><i /></span>}
      </div>

      {expanded && (
        <section className="voice-card no-drag" aria-live="polite">
          <header>
            <span className="voice-status">{t(`voiceOverlay.state.${assistant.state}`, { defaultValue: assistant.state })}</span>
            <button type="button" className="voice-close no-drag" aria-label={t('voiceOverlay.hide')} onClick={assistant.hide}>×</button>
          </header>
          {assistant.transcript && <p className="voice-transcript"><b>{t('voiceOverlay.you')}:</b> {assistant.transcript}</p>}
          {assistant.reply && <p className="voice-reply"><b>{t('voiceOverlay.assistant')}:</b> {assistant.reply}</p>}
          {assistant.error && <p className="voice-overlay-error" role="alert">{t(`voiceOverlay.error.${assistant.error}`, { defaultValue: assistant.error })}</p>}
          {assistant.confirmation && (
            <div className="voice-confirmation" role="alertdialog" aria-label={t('voiceOverlay.confirmation')}>
              <p>{assistant.confirmation.prompt}</p>
              <div>
                <button type="button" disabled={busy} onClick={() => void assistant.submitText(t('voiceOverlay.noValue'))}>{t('voiceOverlay.no')}</button>
                <button type="button" className="primary" disabled={busy} onClick={() => void assistant.submitText(t('voiceOverlay.yesValue'))}>{t('voiceOverlay.yes')}</button>
              </div>
            </div>
          )}
          <form onSubmit={(event) => { event.preventDefault(); submit() }}>
            <input className="no-drag" value={text} disabled={busy} aria-label={t('voiceOverlay.textLabel')} placeholder={t('voiceOverlay.textPlaceholder')} onChange={(event) => setText(event.target.value)} />
            <button type="submit" className="no-drag" disabled={busy || !text.trim()} aria-label={t('voiceOverlay.send')}>↗</button>
          </form>
        </section>
      )}
    </main>
  )
}
