/**
 * Host session chrome for a CLI window — the same view over every vendor TUI.
 *
 * Bronze labels the human (decisions); verdigris pulses where the agent works.
 * The greyhound watermark and VERTRAGVS wordmark are the brand, not decoration
 * around a pasted Cursor transcript: nothing here is parsed from the PTY.
 */
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { CliLogEntry, CliSession } from '@shared/cliSession'
import HoundLogo from '../panel/HoundLogo'

interface Props {
  session: CliSession
  task?: string
  running: boolean
  onFollowUp(text: string): Promise<void>
  onAnswer(questionId: string, text: string): Promise<void>
  /** Focus the composer once the overlay is the thing being typed in. */
  focusComposer?: boolean
}

export function SessionPane({
  session,
  task,
  running,
  onFollowUp,
  onAnswer,
  focusComposer
}: Props): React.JSX.Element {
  const { t } = useTranslation()
  const [draft, setDraft] = useState('')
  const [answer, setAnswer] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const composerRef = useRef<HTMLTextAreaElement>(null)
  const logRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (focusComposer) composerRef.current?.focus()
  }, [focusComposer])

  useEffect(() => {
    const node = logRef.current
    if (!node) return
    node.scrollTop = node.scrollHeight
  }, [session.log.length])

  const question = session.userQuestion ?? session.pendingQuestion
  const questionIsUser = Boolean(session.userQuestion)

  const submitFollowUp = (): void => {
    const text = draft.trim()
    if (!text || busy) return
    setBusy(true)
    setError(null)
    void onFollowUp(text)
      .then(() => setDraft(''))
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : String(cause))
      })
      .finally(() => setBusy(false))
  }

  const submitAnswer = (): void => {
    if (!question || busy) return
    const text = answer.trim()
    if (!text) return
    setBusy(true)
    setError(null)
    void onAnswer(question.questionId, text)
      .then(() => setAnswer(''))
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : String(cause))
      })
      .finally(() => setBusy(false))
  }

  return (
    <div className="cli-session" role="region" aria-label={t('terminal.sessionRegion')}>
      <div className="cli-session-watermark" aria-hidden="true">
        <HoundLogo size={220} hero />
      </div>
      <div className="cli-session-rail">
        <span className="cli-session-mark">VERTRAGVS</span>
        <span className={`cli-session-state is-${session.state}${session.idle ? ' is-idle' : ''}`}>
          {session.idle ? t('terminal.sessionState.idle') : t(`terminal.sessionState.${session.state}`)}
        </span>
        {session.branch ? (
          <span className="cli-session-branch" title={session.branch}>
            {session.branch}
          </span>
        ) : null}
      </div>
      {task?.trim() ? <p className="cli-session-task">{task.trim()}</p> : null}
      <div className="cli-session-log" ref={logRef}>
        {session.log.length === 0 ? (
          <div className="cli-session-empty">
            <p className="cli-session-empty-kicker">{t('terminal.sessionEmptyKicker')}</p>
            <p className="cli-session-empty-copy">{t('terminal.sessionEmpty')}</p>
          </div>
        ) : (
          session.log.map((entry, index) => (
            <LogRow key={`${entry.ts}-${index}-${entry.kind}`} entry={entry} />
          ))
        )}
      </div>
      {question ? (
        <div className={`cli-session-ask${questionIsUser ? ' is-user' : ''}`}>
          <p className="cli-session-ask-label">
            {questionIsUser ? t('terminal.sessionUserQuestion') : t('terminal.sessionQuestion')}
          </p>
          <p className="cli-session-ask-text">{question.question}</p>
          <textarea
            className="cli-session-input"
            rows={2}
            value={answer}
            disabled={busy || !running}
            placeholder={t('terminal.sessionAnswerPlaceholder')}
            onChange={(event) => setAnswer(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault()
                submitAnswer()
              }
            }}
          />
          <button
            type="button"
            className="cli-session-send"
            disabled={busy || !running || !answer.trim()}
            onClick={submitAnswer}
          >
            {t('terminal.sessionAnswerSend')}
          </button>
        </div>
      ) : null}
      <div className="cli-session-composer">
        <textarea
          ref={composerRef}
          className="cli-session-input"
          rows={2}
          value={draft}
          disabled={busy || !running}
          placeholder={t('terminal.sessionFollowUp')}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault()
              submitFollowUp()
            }
          }}
        />
        <button
          type="button"
          className="cli-session-send"
          disabled={busy || !running || !draft.trim()}
          onClick={submitFollowUp}
        >
          {t('terminal.sessionSend')}
        </button>
      </div>
      {error ? <p className="cli-session-error">{error}</p> : null}
    </div>
  )
}

function LogRow({ entry }: { entry: CliLogEntry }): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <article className={`cli-session-row is-${entry.kind}`}>
      <span className="cli-session-kind">{t(`terminal.log.${entry.kind}`)}</span>
      {entry.text ? <p className="cli-session-row-text">{entry.text}</p> : null}
    </article>
  )
}
