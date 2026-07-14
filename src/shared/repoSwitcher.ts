/**
 * Active-repository switcher model shared across processes.
 *
 * A workspace profile still carries a *soft* repository default (its
 * `workingDir` / `githubRepo` binding), but the repository that agents
 * actually work in can be switched independently from the title bar. This
 * module resolves the effective repository and builds the pick list without
 * mutating any profile.
 */
import { z } from 'zod'
import { profileRepoLocalPath, type WorkspaceProfile } from './profile'

/** A repository the user can switch to. Only `path` is authoritative. */
export const repoRefSchema = z.object({
  /** Absolute local working directory of the repository. */
  path: z.string().min(1),
  /** Optional display label; falls back to owner/repo or the folder name. */
  label: z.string().optional(),
  /** Optional GitHub owner (soft — copied from a profile binding or resolved). */
  owner: z.string().optional(),
  /** Optional GitHub repo name. */
  repo: z.string().optional()
})

export type RepoRef = z.infer<typeof repoRefSchema>

/** Maximum number of manually added repositories kept in the recents list. */
export const MAX_RECENT_REPOS = 12

/**
 * Normalized comparison key for a repository path. Mirrors the git tree path
 * handling: backslashes become slashes, trailing slashes are trimmed and
 * Windows drive paths compare case-insensitively.
 */
export function repoRefKey(path: string): string {
  const value = path.trim().replace(/\\/g, '/').replace(/\/+$/, '')
  return /^[a-z]:\//i.test(value) ? value.toLowerCase() : value
}

/** Last path segment of a repository path, working for POSIX and Windows. */
export function repoBasename(path: string): string {
  const parts = path
    .replace(/\\/g, '/')
    .replace(/\/+$/, '')
    .split('/')
    .filter(Boolean)
  return parts[parts.length - 1] ?? ''
}

/** Human-friendly label: explicit label, else owner/repo, else folder name. */
export function repoRefLabel(ref: RepoRef): string {
  const label = ref.label?.trim()
  if (label) return label
  const owner = ref.owner?.trim()
  const repo = ref.repo?.trim()
  if (owner && repo) return `${owner}/${repo}`
  return repoBasename(ref.path) || ref.path.trim()
}

/** Derive the soft repository default from a profile, or null when unbound. */
export function profileRepoRef(
  profile: Pick<WorkspaceProfile, 'name' | 'workingDir' | 'githubRepo'>
): RepoRef | null {
  const path = profileRepoLocalPath(profile).trim()
  if (!path) return null
  const owner = profile.githubRepo?.owner?.trim() || undefined
  const repo = profile.githubRepo?.repo?.trim() || undefined
  return {
    path,
    // Prefer the owner/repo label; otherwise show the profile name so a plain
    // folder binding is still recognizable in the switcher.
    label: owner && repo ? undefined : profile.name,
    owner,
    repo
  }
}

/**
 * Ordered, de-duplicated pick list for the switcher: every profile's soft
 * default first (in profile order), then manually added recents, then the
 * currently active repo if it is not already present.
 */
export function collectKnownRepos(
  profiles: ReadonlyArray<Pick<WorkspaceProfile, 'name' | 'workingDir' | 'githubRepo'>>,
  recents: ReadonlyArray<RepoRef>,
  active?: RepoRef | null
): RepoRef[] {
  const out: RepoRef[] = []
  const seen = new Set<string>()
  const push = (ref: RepoRef | null | undefined): void => {
    if (!ref) return
    const path = ref.path?.trim()
    if (!path) return
    const key = repoRefKey(path)
    if (seen.has(key)) return
    seen.add(key)
    out.push({ ...ref, path })
  }
  for (const profile of profiles) push(profileRepoRef(profile))
  for (const recent of recents) push(recent)
  push(active)
  return out
}

/**
 * Effective repository path: an explicit override wins, otherwise the active
 * profile's soft default is used. Empty string means "no repository selected".
 */
export function resolveActiveRepoPath(
  override: RepoRef | null | undefined,
  activeProfile: Pick<WorkspaceProfile, 'name' | 'workingDir' | 'githubRepo'> | undefined
): string {
  const path = override?.path?.trim()
  if (path) return path
  return activeProfile ? profileRepoLocalPath(activeProfile).trim() : ''
}

/** Parse a stored active-repo override, tolerating legacy/invalid values. */
export function parseActiveRepo(value: unknown): RepoRef | null {
  if (value === null || value === undefined || value === '') return null
  const parsed = repoRefSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}

/** Parse the stored recents list, dropping invalid + duplicate entries. */
export function parseRecentRepos(value: unknown): RepoRef[] {
  if (!Array.isArray(value)) return []
  const out: RepoRef[] = []
  const seen = new Set<string>()
  for (const entry of value) {
    const parsed = repoRefSchema.safeParse(entry)
    if (!parsed.success) continue
    const key = repoRefKey(parsed.data.path)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(parsed.data)
  }
  return out.slice(0, MAX_RECENT_REPOS)
}
