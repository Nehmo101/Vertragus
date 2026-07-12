/**
 * Resolve and validate user-supplied local directory paths (GitHub bind/clone).
 */
import { isAbsolute, normalize, resolve } from 'node:path'

const TRAVERSAL_SEGMENT = /(?:^|[\\/])\.\.(?:[\\/]|$)/
const DEVICE_PATH = /^(\\\\|\\?\?\\|\\?\.\\)/i

export function resolveGithubLocalPath(raw: string, label = 'Lokaler Pfad'): string {
  const trimmed = raw.trim()
  if (!trimmed) throw new Error(`${label} darf nicht leer sein.`)
  if (trimmed.includes('\0')) throw new Error(`${label} enthält ungültige Zeichen.`)
  if (TRAVERSAL_SEGMENT.test(trimmed)) {
    throw new Error(`${label}: Pfad-Traversal ist nicht erlaubt.`)
  }
  if (DEVICE_PATH.test(trimmed)) {
    throw new Error(`${label}: Geräte- oder Spezialpfade sind nicht erlaubt.`)
  }

  const resolved = resolve(trimmed)
  const normalized = normalize(resolved)
  if (normalized.split(/[/\\]/).includes('..')) {
    throw new Error(`${label}: Pfad-Traversal ist nicht erlaubt.`)
  }
  if (!isAbsolute(normalized)) {
    throw new Error(`${label} muss ein absoluter Pfad sein.`)
  }
  return normalized
}

export function resolveGithubLocalPathOptional(raw: string | undefined, label: string): string {
  const trimmed = raw?.trim() ?? ''
  if (!trimmed) return ''
  return resolveGithubLocalPath(trimmed, label)
}
