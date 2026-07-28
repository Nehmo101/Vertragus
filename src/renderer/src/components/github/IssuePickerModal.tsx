import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import Modal from '@renderer/components/ui/Modal'
import Spinner from '@renderer/components/ui/Spinner'
import ErrorCard from '@renderer/components/ui/ErrorCard'
import type { GithubIssueSummary } from '@shared/ipc'
import { filterIssues, relativeUpdatedParts } from './issueGoal'
import styles from './IssuePicker.module.css'

export interface IssuePickerModalProps {
  owner: string
  repo: string
  /** Called with the chosen issue; the caller inserts the goal text (no auto-send). */
  onSelect(issue: GithubIssueSummary): void
  onClose(): void
}

/** Octicon-style "issue opened" glyph (decorative). */
export function IssueGlyph(): JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M8 9.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Z" />
      <path d="M8 0a8 8 0 1 1 0 16A8 8 0 0 1 8 0ZM1.5 8a6.5 6.5 0 1 0 13 0 6.5 6.5 0 0 0-13 0Z" />
    </svg>
  )
}

type LoadState =
  | { kind: 'loading' }
  | { kind: 'error'; detail: string }
  | { kind: 'ready'; issues: GithubIssueSummary[] }

/**
 * Modal list of open GitHub issues of the profile's bound repository.
 * Selecting an issue hands it to the composer as an editable goal draft.
 */
export default function IssuePickerModal({
  owner,
  repo,
  onSelect,
  onClose
}: IssuePickerModalProps): JSX.Element {
  const { t } = useTranslation()
  const [state, setState] = useState<LoadState>({ kind: 'loading' })
  const [query, setQuery] = useState('')

  // Bumping the attempt re-runs the fetch effect; the retry handler flips back
  // to loading from event context, so the effect itself never sets state
  // synchronously.
  const [attempt, setAttempt] = useState(0)
  const retry = (): void => {
    setState({ kind: 'loading' })
    setAttempt((n) => n + 1)
  }

  useEffect(() => {
    let cancelled = false
    void window.vertragus.github
      .listIssues({ owner, repo })
      .then((result) => {
        if (!cancelled) setState({ kind: 'ready', issues: result.issues })
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setState({ kind: 'error', detail: error instanceof Error ? error.message : String(error) })
        }
      })
    return () => {
      cancelled = true
    }
  }, [owner, repo, attempt])

  const visible = useMemo(
    () => (state.kind === 'ready' ? filterIssues(state.issues, query) : []),
    [state, query]
  )

  const updatedLabel = (issue: GithubIssueSummary): string => {
    const parts = relativeUpdatedParts(issue.updatedAt)
    return t(`issues.updated.${parts.key}`, { count: parts.count })
  }

  return (
    <Modal onClose={onClose} labelledBy="issue-picker-title" className="issue-picker-modal">
      <div className="modal-head">
        <span className="modal-gear" aria-hidden="true">
          <IssueGlyph />
        </span>
        <div style={{ flex: 1 }}>
          <div className="modal-title" id="issue-picker-title">
            {t('issues.title', { repo: `${owner}/${repo}` })}
          </div>
          <div className="modal-sub">{t('issues.subtitle')}</div>
        </div>
        <button type="button" className="modal-close" aria-label={t('issues.close')} onClick={onClose}>
          ✕
        </button>
      </div>

      {state.kind === 'loading' && (
        <div className={styles.state}>
          <Spinner />
          <span>{t('issues.loading')}</span>
        </div>
      )}

      {state.kind === 'error' && (
        <ErrorCard
          title={t('issues.errorTitle')}
          detail={state.detail}
          onRetry={retry}
          retryLabel={t('issues.retry')}
        />
      )}

      {state.kind === 'ready' && (
        <>
          <input
            type="search"
            className={styles.search}
            value={query}
            aria-label={t('issues.searchLabel')}
            placeholder={t('issues.searchPlaceholder')}
            onChange={(event) => setQuery(event.currentTarget.value)}
          />
          {state.issues.length === 0 ? (
            <div className={styles.state}>{t('issues.empty')}</div>
          ) : visible.length === 0 ? (
            <div className={styles.state}>{t('issues.noMatches')}</div>
          ) : (
            <ul className={styles.list}>
              {visible.map((issue) => (
                <li key={issue.number}>
                  <button
                    type="button"
                    className={styles.row}
                    onClick={() => onSelect(issue)}
                    title={t('issues.selectTitle', { number: issue.number })}
                  >
                    <span className={styles.rowHead}>
                      <span className={styles.number}>#{issue.number}</span>
                      <span className={styles.title}>{issue.title}</span>
                    </span>
                    <span className={styles.rowMeta}>
                      {issue.labels.map((label) => (
                        <span key={label} className={styles.chip}>
                          {label}
                        </span>
                      ))}
                      <span>{updatedLabel(issue)}</span>
                      {issue.author && <span>{t('issues.byAuthor', { author: issue.author })}</span>}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </Modal>
  )
}
