/**
 * Reads the app-level active-repository override the title-bar switcher writes.
 * The override is a *soft* replacement for a profile's repository default: when
 * set it decides where a launched team works, otherwise the profile binding is
 * used.
 */
import { getSetting } from '@main/config/store'
import { parseActiveRepo } from '@shared/repoSwitcher'

/** Effective override working directory, or '' when no override is active. */
export function getActiveRepoOverridePath(): string {
  return parseActiveRepo(getSetting('workspaceRepo.active'))?.path?.trim() ?? ''
}
