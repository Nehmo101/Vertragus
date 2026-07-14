/**
 * Retro-sync target configuration (read-side fallbacks to the shared
 * defaults). Separate module so exporter and overlay can share it without an
 * import cycle.
 */
import { getSetting } from '@main/config/store'
import { RETRO_SYNC_DEFAULTS, type RetroSyncConfig } from '@shared/retroSync'

export function retroSyncConfig(): RetroSyncConfig {
  return {
    enabled: getSetting<boolean>('retroSync.enabled') ?? RETRO_SYNC_DEFAULTS.enabled,
    repoOwner: getSetting<string>('retroSync.repoOwner')?.trim() || RETRO_SYNC_DEFAULTS.repoOwner,
    repoName: getSetting<string>('retroSync.repoName')?.trim() || RETRO_SYNC_DEFAULTS.repoName,
    branch: getSetting<string>('retroSync.branch')?.trim() || RETRO_SYNC_DEFAULTS.branch
  }
}
