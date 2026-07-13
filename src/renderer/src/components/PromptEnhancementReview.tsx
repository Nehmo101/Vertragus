import { useEffect, useRef } from 'react'
import type { PromptEnhancementSelection } from '@shared/promptEnhancement'
import {
  PROMPT_ENHANCEMENT_A11Y,
  isPromptReviewCancelKey,
  promptEnhancementOutput,
  promptProviderModelLabel,
  shouldFocusPromptReview,
  type PromptEnhancementSession
} from '@renderer/inboxPrompt'

interface Props {
  session: PromptEnhancementSession
  onCancel(): void
  onRetry(selection?: PromptEnhancementSelection): void
  onFallback(): void
  onCopy(): void
  onRequestApply(): void
  onConfirmApply(): void
  onCancelApply(): void
}

export default function PromptEnhancementReview({
  session,
  onCancel,
  onRetry,
  onFallback,
  onCopy,
  onRequestApply,
  onConfirmApply,
  onCancelApply
}: Props): JSX.Element | null {
  const regionRef = useRef<HTMLElement>(null)
  useEffect(() => {
    if (shouldFocusPromptReview(session.open)) regionRef.current?.focus()
  }, [session.open, session.phase])

  if (!session.open || !session.original) return null
  const result = session.result
  const output = promptEnhancementOutput(result)
  const candidates = result &&
    (result.status === 'selection-required' || result.status === 'provider-unavailable')
    ? result.candidates
    : []
  const message = result && 'message' in result ? result.message : ''
  const warnings = result && 'warnings' in result ? result.warnings : []

  return (
    <section
      ref={regionRef}
      className="inbox-prompt-review"
      aria-label={PROMPT_ENHANCEMENT_A11Y.regionLabel}
      aria-live={PROMPT_ENHANCEMENT_A11Y.live}
      tabIndex={-1}
      onKeyDown={(event) => {
        if (isPromptReviewCancelKey(event.key)) {
          event.preventDefault()
          onCancel()
        }
      }}
    >
      <div className="inbox-prompt-review-head">
        <div>
          <b>{session.phase === 'loading' ? 'Wird geschärft …' : 'Prompt-Verbesserung prüfen'}</b>
          <span>{promptProviderModelLabel(result)}</span>
        </div>
        <button type="button" className="inbox-btn ghost sm" onClick={onCancel}>
          Abbrechen
        </button>
      </div>

      {session.phase === 'loading' && <div role="status">Provider und Modell werden im Main-Prozess ausgeführt.</div>}
      {message && (
        <div className={session.phase === 'error' ? 'inbox-error' : 'inbox-transfer-hint'} role={session.phase === 'error' ? 'alert' : undefined}>
          {message}
        </div>
      )}
      {result?.status === 'fallback' || result?.status === 'local-fallback' ? (
        <div className="inbox-prompt-fallback-badge">Deterministischer Fallback – keine KI-Verbesserung</div>
      ) : null}
      {warnings.length > 0 && <div className="inbox-transfer-hint">{warnings.join(' ')}</div>}

      <div className="inbox-prompt-compare">
        <article>
          <h3>Original</h3>
          <b>{session.original.title || 'Ohne Titel'}</b>
          <pre>{session.original.content || '—'}</pre>
        </article>
        <article>
          <h3>{result?.status === 'enhanced' ? 'KI-Verbesserung' : 'Vorschlag'}</h3>
          {output ? (
            <>
              <b>{output.title}</b>
              <pre>{output.prompt}</pre>
            </>
          ) : (
            <div className="inbox-empty small">
              {session.phase === 'loading' ? 'Antwort wird vorbereitet …' : 'Noch kein Verbesserungsvorschlag.'}
            </div>
          )}
        </article>
      </div>

      {candidates.length > 0 && (
        <div className="inbox-prompt-candidates" aria-label="Provider ausdrücklich auswählen">
          {candidates.map((candidate) => {
            const selectable = result?.status === 'selection-required' &&
              (candidate.status === 'ready' || candidate.status === 'unverified')
            return (
              <span key={candidate.provider} className={`inbox-prompt-candidate state-${candidate.status}`}>
                <span title={candidate.detail}>
                  {candidate.label} · {candidate.status === 'ready' ? 'verfügbar' : candidate.status === 'needs-login' ? 'Anmeldung nötig' : candidate.status === 'unverified' ? 'Status ungeprüft' : 'nicht verfügbar'}
                </span>
                {selectable && (
                  <button
                    type="button"
                    className="inbox-btn ghost sm"
                    onClick={() => onRetry({ provider: candidate.provider })}
                  >
                    CLI-Standard auswählen
                  </button>
                )}
              </span>
            )
          })}
        </div>
      )}

      {(result?.status === 'selection-required' || result?.status === 'provider-unavailable') && (
        <button type="button" className="inbox-btn ghost sm" onClick={onFallback}>
          Deterministischen Fallback anzeigen (keine KI)
        </button>
      )}

      <div className="inbox-prompt-review-actions">
        {result?.status !== 'selection-required' && session.phase !== 'loading' && (
          <button type="button" className="inbox-btn ghost" onClick={() => onRetry(session.selection)}>
            Erneut schärfen
          </button>
        )}
        {output && (
          <>
            <button type="button" className="inbox-btn ghost" onClick={onCopy}>
              {session.copied ? 'Kopiert' : 'Kopieren'}
            </button>
            {!session.confirmApply ? (
              <button type="button" className="inbox-btn" onClick={onRequestApply}>
                Übernehmen
              </button>
            ) : (
              <span className="inbox-prompt-apply-confirm" role="group" aria-label="Übernahme bestätigen">
                <span>Nur lokalen Titel und Inhalt ersetzen?</span>
                <button type="button" className="inbox-btn ghost sm" onClick={onCancelApply}>Nein</button>
                <button type="button" className="inbox-btn sm" onClick={onConfirmApply}>Ja, übernehmen</button>
              </span>
            )}
          </>
        )}
      </div>
    </section>
  )
}
