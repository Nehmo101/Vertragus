/**
 * Short-lived, single-use grants for native file-picker selections.
 * Renderer must not pass arbitrary filesystem paths for inbox file artifacts.
 */
import { randomUUID } from 'node:crypto'
import { basename, resolve } from 'node:path'

const GRANT_TTL_MS = 5 * 60 * 1000

interface PickerGrant {
  path: string
  expiresAt: number
}

const grants = new Map<string, PickerGrant>()

export interface PickedFileGrant {
  grantId: string
  fileName: string
}

export function issuePickerGrant(rawPath: string): PickedFileGrant {
  const path = resolve(rawPath.trim())
  const grantId = randomUUID()
  grants.set(grantId, { path, expiresAt: Date.now() + GRANT_TTL_MS })
  return { grantId, fileName: basename(path) }
}

export function consumePickerGrant(grantId: string): string {
  const id = grantId.trim()
  if (!id) throw new Error('Datei-Freigabe fehlt.')
  const grant = grants.get(id)
  if (!grant) throw new Error('Datei-Freigabe ungültig oder abgelaufen.')
  if (Date.now() > grant.expiresAt) {
    grants.delete(id)
    throw new Error('Datei-Freigabe abgelaufen.')
  }
  grants.delete(id)
  return grant.path
}

/** Test hook: reset in-memory grants. */
export function __clearPickerGrantsForTest(): void {
  grants.clear()
}
