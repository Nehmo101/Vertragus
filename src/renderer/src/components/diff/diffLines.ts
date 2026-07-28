/**
 * Pure classification helpers for rendering unified-diff text line by line.
 * Kept free of React/CSS imports so they stay trivially unit-testable.
 */

export type DiffLineKind = 'file' | 'hunk' | 'add' | 'del' | 'meta' | 'context'

const META_PREFIXES = [
  'index ',
  'mode ',
  'old mode',
  'new mode',
  'new file mode',
  'deleted file mode',
  'similarity index',
  'dissimilarity index',
  'rename from',
  'rename to',
  'copy from',
  'copy to',
  'Binary files ',
  '\\ No newline'
] as const

/**
 * Classify one line of a unified diff. File headers (`diff --git`, `+++`, `---`)
 * are checked before add/delete so `+++ b/x` is never rendered as an addition.
 */
export function classifyDiffLine(line: string): DiffLineKind {
  if (line.startsWith('diff --git ')) return 'file'
  if (line.startsWith('+++ ') || line === '+++') return 'file'
  if (line.startsWith('--- ') || line === '---') return 'file'
  if (line.startsWith('@@')) return 'hunk'
  for (const prefix of META_PREFIXES) {
    if (line.startsWith(prefix)) return 'meta'
  }
  if (line.startsWith('+')) return 'add'
  if (line.startsWith('-')) return 'del'
  return 'context'
}

/** Number of changed files, derived from the `diff --git` block headers. */
export function countDiffFiles(diff: string): number {
  let count = 0
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) count += 1
  }
  return count
}
