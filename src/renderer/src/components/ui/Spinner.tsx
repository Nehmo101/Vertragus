import styles from './Spinner.module.css'

/**
 * Small inline spinner for long-running actions (same look as the
 * profile-generate spinner, but currentColor-based so it adapts to the
 * button it sits in). Decorative — pair it with a visible label.
 */
export default function Spinner({ className }: { className?: string }): JSX.Element {
  return (
    <span
      className={className ? `${styles.spinner} ${className}` : styles.spinner}
      aria-hidden="true"
    />
  )
}
