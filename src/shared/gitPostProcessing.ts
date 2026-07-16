const MAX_BRANCH_LENGTH = 200

/**
 * Conservative branch policy shared by profile validation, renderer feedback
 * and the main-process Git service. Keeping this pure prevents the UI and the
 * mutation boundary from accepting different inputs.
 */
export function isValidPostProcessBranch(branch: string): boolean {
  if (!branch || branch.length > MAX_BRANCH_LENGTH || branch.toUpperCase() === 'HEAD') return false
  if (branch.includes('..') || branch.includes('//')) return false

  return branch.split('/').every((segment) =>
    segment.length > 0 &&
    !segment.toLowerCase().endsWith('.lock') &&
    /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9_-])?$/.test(segment)
  )
}

/** User-facing validation used by both zod and the profile editor. */
export function postProcessBranchValidationError(branch: string, enabled: boolean): string | undefined {
  if (!branch) {
    return enabled ? 'Für Auto-Commit & Push muss ein Ziel-Branch angegeben werden.' : undefined
  }
  return isValidPostProcessBranch(branch)
    ? undefined
    : 'Der Ziel-Branch ist ungültig. Erlaubt sind Buchstaben, Zahlen, Punkt, Unterstrich, Bindestrich und /.'
}

export type WorkspaceGitPostProcessingStatus = 'running' | 'clean' | 'pushed' | 'failed'

/** Safe renderer/persistence projection of the main-process Git result. */
export interface WorkspaceGitPostProcessingSnapshot {
  planId: string
  status: WorkspaceGitPostProcessingStatus
  targetBranch: string
  changedFiles: string[]
  startedAt: number
  finishedAt?: number
  sourceBranch?: string
  commit?: string
  error?: {
    code: string
    phase: string
    message: string
    detail?: string
    mutation: string
  }
}
