import { useTranslation } from 'react-i18next'
import styles from './ErrorCard.module.css'

/** Raw details longer than this are hidden behind a disclosure. */
export const DETAIL_COLLAPSE_THRESHOLD = 120

/**
 * True when a raw error detail is long or technical enough that it should be
 * collapsed behind a "technical details" disclosure instead of shown inline:
 * multi-line output, stack-trace-ish content, or anything past the threshold.
 */
export function shouldCollapseDetail(detail: string): boolean {
  const value = detail.trim()
  if (value.length > DETAIL_COLLAPSE_THRESHOLD) return true
  if (value.includes('\n')) return true
  // Typical technical fingerprints: error-class prefixes and Electron IPC wrappers.
  return /(^|\s)[A-Za-z]*Error:|Error invoking remote method/.test(value)
}

export interface ErrorCardProps {
  /** Human-readable headline; defaults to a generic one. */
  title?: string
  /** Raw (technical) message, collapsed behind a disclosure when long. */
  detail?: string
  /** Renders a retry button when provided. */
  onRetry?: () => void
  retryLabel?: string
  /** Disables the retry button, e.g. while the retried call is running. */
  retryDisabled?: boolean
  className?: string
}

/**
 * Compact error card with a friendly title, the raw exception message as
 * (collapsible) detail, and an optional retry action. Replaces the bare
 * `<div role="alert">{rawMessage}</div>` pattern.
 */
export default function ErrorCard({
  title,
  detail,
  onRetry,
  retryLabel,
  retryDisabled = false,
  className
}: ErrorCardProps): JSX.Element {
  const { t } = useTranslation()
  return (
    <div role="alert" className={className ? `${styles.card} ${className}` : styles.card}>
      <div className={styles.body}>
        <strong className={styles.title}>{title ?? t('ui.errorCard.title')}</strong>
        {detail && (shouldCollapseDetail(detail) ? (
          <details className={styles.details}>
            <summary className={styles.summary}>{t('ui.errorCard.details')}</summary>
            <pre className={styles.detailText}>{detail}</pre>
          </details>
        ) : (
          <p className={styles.detail}>{detail}</p>
        ))}
      </div>
      {onRetry && (
        <button type="button" className={styles.retry} disabled={retryDisabled} onClick={onRetry}>
          {retryLabel ?? t('ui.errorCard.retry')}
        </button>
      )}
    </div>
  )
}
