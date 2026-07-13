export type CommittedTaskChange = { result: 'committed'; commit: string; noChanges: false }
export type NoTaskChanges = { result: 'no-changes'; noChanges: true }
export type TaskChangeContract = CommittedTaskChange | NoTaskChanges

export function noTaskChanges(): NoTaskChanges {
  return { result: 'no-changes', noChanges: true }
}

export function isFullCommitHash(value: string): boolean {
  return /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(value.trim())
}

export function verifiedTaskCommit(commit: string, resolvedCommit: string): CommittedTaskChange {
  const expected = commit.trim().toLowerCase()
  const resolved = resolvedCommit.trim().toLowerCase()
  if (!isFullCommitHash(expected) || expected !== resolved) {
    throw new Error('Commit-Vertrag verletzt: Commit-Hash ist nicht eindeutig verifiziert.')
  }
  return { result: 'committed', commit: resolved, noChanges: false }
}
