import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
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
  const { t } = useTranslation()
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

  const candidateStatus = (status: string): string => {
    switch (status) {
      case 'ready':
        return t('promptReview.candidateReady')
      case 'needs-login':
        return t('promptReview.candidateLogin')
      case 'unverified':
        return t('promptReview.candidateUnverified')
      default:
        return t('promptReview.candidateUnavailable')
    }
  }

  return (
    <section
      ref={regionRef}
      className="inbox-prompt-review"
      aria-label={t('promptReview.regionLabel')}
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
          <b>{session.phase === 'loading' ? t('promptReview.sharpening') : t('promptReview.title')}</b>
          <span>
            {promptProviderModelLabel(result, {
              cliDefault: t('promptReview.cliDefault'),
              localNoModel: t('promptReview.localNoModel')
            })}
          </span>
        </div>
        <button type="button" className="inbox-btn ghost sm" onClick={onCancel}>
          {t('promptReview.cancel')}
        </button>
      </div>

      {session.phase === 'loading' && <div role="status">{t('promptReview.loadingHint')}</div>}
      {message && (
        <div className={session.phase === 'error' ? 'inbox-error' : 'inbox-transfer-hint'} role={session.phase === 'error' ? 'alert' : undefined}>
          {message}
        </div>
      )}
      {result?.status === 'fallback' || result?.status === 'local-fallback' ? (
        <div className="inbox-prompt-fallback-badge">{t('promptReview.fallbackBadge')}</div>
      ) : null}
      {warnings.length > 0 && <div className="inbox-transfer-hint">{warnings.join(' ')}</div>}

      <div className="inbox-prompt-compare">
        <article>
          <h3>{t('promptReview.original')}</h3>
          <b>{session.original.title || t('promptReview.untitled')}</b>
          <pre>{session.original.content || '—'}</pre>
        </article>
        <article>
          <h3>{result?.status === 'enhanced' ? t('promptReview.aiEnhancement') : t('promptReview.suggestion')}</h3>
          {output ? (
            <>
              <b>{output.title}</b>
              <pre>{output.prompt}</pre>
            </>
          ) : (
            <div className="inbox-empty small">
              {session.phase === 'loading' ? t('promptReview.preparing') : t('promptReview.noSuggestion')}
            </div>
          )}
        </article>
      </div>

      {candidates.length > 0 && (
        <div className="inbox-prompt-candidates" aria-label={t('promptReview.candidatesAria')}>
          {candidates.map((candidate) => {
            const selectable = result?.status === 'selection-required' &&
              (candidate.status === 'ready' || candidate.status === 'unverified')
            return (
              <span key={candidate.provider} className={`inbox-prompt-candidate state-${candidate.status}`}>
                <span title={candidate.detail}>
                  {candidate.label} · {candidateStatus(candidate.status)}
                </span>
                {selectable && (
                  <button
                    type="button"
                    className="inbox-btn ghost sm"
                    onClick={() => onRetry({ provider: candidate.provider })}
                  >
                    {t('promptReview.chooseCliDefault')}
                  </button>
                )}
              </span>
            )
          })}
        </div>
      )}

      {(result?.status === 'selection-required' || result?.status === 'provider-unavailable') && (
        <button type="button" className="inbox-btn ghost sm" onClick={onFallback}>
          {t('promptReview.showFallback')}
        </button>
      )}

      <div className="inbox-prompt-review-actions">
        {result?.status !== 'selection-required' && session.phase !== 'loading' && (
          <button type="button" className="inbox-btn ghost" onClick={() => onRetry(session.selection)}>
            {t('promptReview.retry')}
          </button>
        )}
        {output && (
          <>
            <button type="button" className="inbox-btn ghost" onClick={onCopy}>
              {session.copied ? t('promptReview.copied') : t('promptReview.copy')}
            </button>
            {!session.confirmApply ? (
              <button type="button" className="inbox-btn" onClick={onRequestApply}>
                {t('promptReview.apply')}
              </button>
            ) : (
              <span className="inbox-prompt-apply-confirm" role="group" aria-label={t('promptReview.applyConfirmAria')}>
                <span>{t('promptReview.applyConfirmQuestion')}</span>
                <button type="button" className="inbox-btn ghost sm" onClick={onCancelApply}>{t('promptReview.no')}</button>
                <button type="button" className="inbox-btn sm" onClick={onConfirmApply}>{t('promptReview.yesApply')}</button>
              </span>
            )}
          </>
        )}
      </div>
    </section>
  )
}
