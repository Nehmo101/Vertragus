/**
 * Shared retro-sync contract: config shape, validation and the branch guard
 * for the dedicated retro data branch. Pure module — usable from main,
 * renderer and the analysis CLI.
 */

export interface RetroSyncConfig {
  enabled: boolean
  repoOwner: string
  repoName: string
  branch: string
}

/** Read-side fallbacks; nothing is exported until the user enables the sync. */
export const RETRO_SYNC_DEFAULTS: RetroSyncConfig = {
  enabled: false,
  repoOwner: 'Nehmo101',
  repoName: 'Vertragus',
  branch: 'retros'
}

export interface RetroSyncStatus extends RetroSyncConfig {
  queued: number
  lastExportAt?: number
  lastError?: string
}

export type RetroExportKind = 'run-retro' | 'benchmark' | 'learnings'

/** Envelope wrapped around every artifact exported to the retro branch. */
export interface RetroExportEnvelope<T = unknown> {
  version: 1
  exportedAt: number
  app: { name: string; version: string }
  /** Pseudonymous, stable per installation — never hostname or username. */
  machineId: string
  kind: RetroExportKind
  payload: T
}

export function normalizeRetroSyncOwner(value: unknown): string {
  const raw = typeof value === 'string' ? value : ''
  const owner = raw.trim().replace(/^@/, '')
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(owner)) {
    throw new Error(`Ungültiger GitHub-Owner für Retro-Sync: ${raw || String(value)}`)
  }
  return owner
}

export function normalizeRetroSyncRepo(value: unknown): string {
  const raw = typeof value === 'string' ? value : ''
  const repo = raw.trim()
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(repo)) {
    throw new Error(`Ungültiger GitHub-Repo-Name für Retro-Sync: ${raw || String(value)}`)
  }
  return repo
}

const PROTECTED_BRANCHES = new Set(['main', 'master'])

/**
 * Refuses code branches so retro data can never land on main/master or the
 * repository default branch. Returns the normalized branch name.
 */
export function assertSafeRetroBranch(branch: unknown, defaultBranch?: string): string {
  const raw = typeof branch === 'string' ? branch : ''
  const normalized = raw.trim()
  if (!/^[A-Za-z0-9._/-]{1,120}$/.test(normalized)) {
    throw new Error(`Ungültiger Retro-Branch-Name: ${raw || String(branch)}`)
  }
  const lowered = normalized.toLowerCase()
  const isDefault = Boolean(defaultBranch && lowered === defaultBranch.trim().toLowerCase())
  if (PROTECTED_BRANCHES.has(lowered) || isDefault) {
    throw new Error(`Retro-Sync verweigert den geschützten Branch "${normalized}".`)
  }
  return normalized
}
