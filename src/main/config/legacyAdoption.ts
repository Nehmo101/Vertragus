/**
 * One-time adoption of pre-rebrand ("orca") userData files and directories
 * into their Vertragus names. Copy-only: the legacy source is never deleted,
 * so a crash mid-adoption or a downgrade loses nothing. Mirrors the
 * orca-strator.json → vertragus.json adoption in config/store.ts.
 */
import { copyFileSync, cpSync, existsSync } from 'node:fs'
import { join } from 'node:path'

/** Copy `<dir>/<legacyName>` to `<dir>/<newName>` unless the target exists. */
export function adoptLegacyFile(dir: string, legacyName: string, newName: string): void {
  const legacyPath = join(dir, legacyName)
  const newPath = join(dir, newName)
  try {
    if (existsSync(legacyPath) && !existsSync(newPath)) {
      copyFileSync(legacyPath, newPath)
    }
  } catch {
    // Adoption is best-effort: on failure the caller starts empty and the
    // legacy data stays intact on disk for a later attempt.
  }
}

/** Recursively copy `<dir>/<legacyName>/` to `<dir>/<newName>/` unless the target exists. */
export function adoptLegacyDir(dir: string, legacyName: string, newName: string): void {
  const legacyPath = join(dir, legacyName)
  const newPath = join(dir, newName)
  try {
    if (existsSync(legacyPath) && !existsSync(newPath)) {
      cpSync(legacyPath, newPath, { recursive: true })
    }
  } catch {
    // Best-effort, see adoptLegacyFile.
  }
}
