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
import { useDraft } from '../lib/useDraft'
import { questionChoicesDisplay } from '@shared/questionChoicesDisplay'
import HoundLogo from '../panel/HoundLogo'

interface Props {
  session: CliSession
  agentId: string
  task?: string
  running: boolean
  onFollowUp(text: string): Promise<void>
  onAnswer(questionId: string, text: string): Promise<void>
  /** Focus the composer once the overlay is the thing being typed in. */
  focusComposer?: boolean
}

export function SessionPane({
  session,
  agentId,
  task,
  running,
  onFollowUp,
  onAnswer,
  focusComposer
}: Props): React.JSX.Element {
  const { t } = useTranslation()
  const followUpDraft = useDraft(`workspace.${session.workspaceId}.${agentId}.composer`, '')
  const { value: draft, set: setDraft } = followUpDraft
  const question = session.userQuestion ?? session.pendingQuestion
  const answerDraft = useDraft(`answer.${session.userQuestion ? 'user' : agentId}.${question?.questionId ?? ''}`, '')
  const { value: answer, set: setAnswer } = answerDraft
  const display = questionChoicesDisplay(question?.question ?? '', question?.choices)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const composerRef = useRef<HTMLTextAreaElement>(null)
  const logRef = useRef<HTMLDivElement>(null)
  const followLog = useRef(true)
  const [newEvents, setNewEvents] = useState(0)
  const lastLog = session.log[session.log.length - 1]
  const logVersion = lastLog ? `${lastLog.ts}:${lastLog.kind}:${lastLog.text}` : ''

  useEffect(() => {
    if (focusComposer) composerRef.current?.focus()
  }, [focusComposer])

  useEffect(() => {
    const node = logRef.current
    if (!node) return
    if (followLog.current) node.scrollTop = node.scrollHeight
    else setNewEvents((count) => count + 1)
  }, [logVersion])

  const questionIsUser = Boolean(session.userQuestion)

  const submitFollowUp = (): void => {
    const text = draft.trim()
    if (!text || busy) return
    setBusy(true)
    setError(null)
    const version = followUpDraft.version()
    void onFollowUp(text)
      .then(() => followUpDraft.clear(version))
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : String(cause))
      })
      .finally(() => setBusy(false))
  }

  const submitAnswer = (value = answer): void => {
    if (!question || busy) return
    const text = value.trim()
    if (!text) return
    setBusy(true)
    setError(null)
    const version = answerDraft.version()
    void onAnswer(question.questionId, text)
      .then(() => answerDraft.clear(version))
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
      <div className="cli-session-log" ref={logRef} onScroll={(event) => {
        const node = event.currentTarget
        followLog.current = node.scrollHeight - node.scrollTop - node.clientHeight < 32
        if (followLog.current) setNewEvents(0)
      }}>
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
      {newEvents > 0 ? <button type="button" className="cli-session-send" onClick={() => { followLog.current = true; if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight; setNewEvents(0) }}>{t('timeline.newEvents', { count: newEvents })}</button> : null}
      {question ? (
        <div className={`cli-session-ask${questionIsUser ? ' is-user' : ''}`}>
          <p className="cli-session-ask-label">
            {questionIsUser ? t('terminal.sessionUserQuestion') : t('terminal.sessionQuestion')}
          </p>
          <p className="cli-session-ask-text">{display.prompt}</p>
          {display.choices.map((choice) => <button key={choice} type="button" className="cli-session-send" disabled={busy || !running} onClick={() => submitAnswer(choice)}>{choice}</button>)}
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
            onClick={() => submitAnswer()}
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
