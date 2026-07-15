/**
 * Guard generic configGet/configSet IPC — only public UI keys; never secrets.*.
 */
import { getSetting, setSetting } from '@main/config/store'
import {
  parseDisabledModels,
  parseProviderEnabled,
  parseProviderLimits
} from '@shared/providers'
import {
  assertSafeRetroBranch,
  normalizeRetroSyncOwner,
  normalizeRetroSyncRepo
} from '@shared/retroSync'
import { parseActiveRepo, parseRecentRepos } from '@shared/repoSwitcher'

/** Keys the renderer may read via config:get. */
export const PUBLIC_CONFIG_GET_KEYS = new Set([
  'yoloMaster',
  'ui.theme',
  'ui.workspaceLayout',
  'ui.density',
  'ui.cliReadable',
  'providerLimits',
  'providerEnabled',
  'disabledModels',
  'retroSync.enabled',
  'retroSync.repoOwner',
  'retroSync.repoName',
  'retroSync.branch',
  'workspaceRepo.active',
  'workspaceRepo.recent'
])

/** Keys the renderer may write via config:set. */
export const PUBLIC_CONFIG_SET_KEYS = new Set([
  'yoloMaster',
  'ui.theme',
  'ui.workspaceLayout',
  'ui.density',
  'ui.cliReadable',
  'providerLimits',
  'providerEnabled',
  'disabledModels',
  'retroSync.enabled',
  'retroSync.repoOwner',
  'retroSync.repoName',
  'retroSync.branch',
  'workspaceRepo.active',
  'workspaceRepo.recent'
])

function rejectSecretsKey(key: string, action: 'read' | 'write'): void {
  if (key.startsWith('secrets.')) {
    const verb = action === 'read' ? 'lesen' : 'schreiben'
    throw new Error(`Config-Schlüssel "${key}" darf nicht per IPC ${verb} werden.`)
  }
}

export function assertConfigGetAllowed(key: string): void {
  rejectSecretsKey(key, 'read')
  if (!PUBLIC_CONFIG_GET_KEYS.has(key)) {
    throw new Error(`Config-Schlüssel "${key}" ist nicht über IPC lesbar.`)
  }
}

export function assertConfigSetAllowed(key: string): void {
  rejectSecretsKey(key, 'write')
  if (!PUBLIC_CONFIG_SET_KEYS.has(key)) {
    throw new Error(`Config-Schlüssel "${key}" ist nicht über IPC schreibbar.`)
  }
}

export function getPublicConfig<T = unknown>(key: string): T | undefined {
  assertConfigGetAllowed(key)
  return getSetting<T>(key)
}

export function setPublicConfig(key: string, value: unknown): void {
  assertConfigSetAllowed(key)
  if (key === 'providerLimits') {
    setSetting(key, parseProviderLimits(value))
    return
  }
  if (key === 'providerEnabled') {
    setSetting(key, parseProviderEnabled(value))
    return
  }
  if (key === 'disabledModels') {
    setSetting(key, parseDisabledModels(value))
    return
  }
  if (key === 'retroSync.enabled') {
    if (typeof value !== 'boolean') {
      throw new Error('retroSync.enabled erwartet true oder false.')
    }
    setSetting(key, value)
    return
  }
  if (key === 'retroSync.repoOwner') {
    setSetting(key, normalizeRetroSyncOwner(value))
    return
  }
  if (key === 'retroSync.repoName') {
    setSetting(key, normalizeRetroSyncRepo(value))
    return
  }
  if (key === 'retroSync.branch') {
    setSetting(key, assertSafeRetroBranch(value))
    return
  }
  if (key === 'workspaceRepo.active') {
    // A cleared override is stored as null so it never masks the profile default.
    setSetting(key, parseActiveRepo(value))
    return
  }
  if (key === 'workspaceRepo.recent') {
    setSetting(key, parseRecentRepos(value))
    return
  }
  setSetting(key, value)
}
