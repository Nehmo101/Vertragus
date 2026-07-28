import { useMemo } from 'react'
import { classifyDiffLine } from './diffLines'
import styles from './DiffView.module.css'

export { classifyDiffLine, countDiffFiles } from './diffLines'
export type { DiffLineKind } from './diffLines'

/**
 * Renders a unified-diff string line by line: additions green, deletions red,
 * hunk headers and file headers visually set apart. Lines never wrap; long
 * lines scroll horizontally inside the container.
 */
export default function DiffView({ diff }: { diff: string }): JSX.Element {
  const lines = useMemo(() => diff.replace(/\n$/, '').split('\n'), [diff])
  return (
    <div className={styles.diff}>
      <div className={styles.lines}>
        {lines.map((line, index) => {
          const kind = classifyDiffLine(line)
          const classes = [styles.line, styles[kind]]
          if (line.startsWith('diff --git ')) classes.push(styles.fileStart)
          return (
            <div className={classes.join(' ')} key={index}>
              {line === '' ? ' ' : line}
            </div>
          )
        })}
      </div>
    </div>
  )
}
