/**
 * Learnings overlay: the human-reviewed rule set from the retro branch
 * (overlay/learnings.md), cached on disk and injected synchronously into the
 * orchestrator system prompt. Launches never block on network — a stale or
 * missing overlay simply means launching with the last cached rules or none.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import { getRepoFile } from '@main/integrations/githubContents'
import { retroSyncConfig } from '@main/orchestrator/retroSyncConfig'

export const OVERLAY_MAX_BYTES = 16 * 1024
export const OVERLAY_MAX_LINES = 80
const OVERLAY_TTL_MS = 30 * 60_000
const OVERLAY_BRANCH_PATH = 'overlay/learnings.md'

interface OverlayCache {
  text?: string
  fetchedAt: number
}

let memoryCache: OverlayCache | undefined
let refreshing = false

function cacheDir(): string {
  return join(app.getPath('userData'), 'retro-sync')
}

/** Trim, strip control chars and cap the overlay at a line boundary. */
export function sanitizeOverlay(raw: string): string {
  const cleaned = raw
    .replace(/\r\n?/g, '\n')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .trim()
  if (!cleaned) return ''
  const lines = cleaned.split('\n').slice(0, OVERLAY_MAX_LINES)
  const kept: string[] = []
  let bytes = 0
  for (const line of lines) {
    const size = Buffer.byteLength(line, 'utf8') + 1
    if (bytes + size > OVERLAY_MAX_BYTES) break
    kept.push(line)
    bytes += size
  }
  return kept.join('\n').trim()
}

function readDiskCache(): OverlayCache {
  try {
    const meta = JSON.parse(
      readFileSync(join(cacheDir(), 'overlay.meta.json'), 'utf8')
    ) as { fetchedAt?: number }
    const text = sanitizeOverlay(readFileSync(join(cacheDir(), 'overlay.md'), 'utf8'))
    return { text: text || undefined, fetchedAt: meta.fetchedAt ?? 0 }
  } catch {
    return { fetchedAt: 0 }
  }
}

function writeDiskCache(text: string): void {
  try {
    mkdirSync(cacheDir(), { recursive: true })
    writeFileSync(join(cacheDir(), 'overlay.md'), text, 'utf8')
    writeFileSync(
      join(cacheDir(), 'overlay.meta.json'),
      JSON.stringify({ fetchedAt: Date.now() }),
      'utf8'
    )
  } catch (error) {
    console.warn('[RetroSync] Overlay-Cache konnte nicht geschrieben werden', error)
  }
}

/** Fetch the overlay from the retro branch into the caches; never throws. */
export async function refreshPromptOverlay(): Promise<void> {
  if (refreshing) return
  refreshing = true
  try {
    const config = retroSyncConfig()
    if (!config.enabled) return
    const file = await getRepoFile(
      { owner: config.repoOwner, repo: config.repoName, branch: config.branch },
      OVERLAY_BRANCH_PATH
    )
    if (file) {
      const text = sanitizeOverlay(file.content)
      writeDiskCache(text)
      memoryCache = { text: text || undefined, fetchedAt: Date.now() }
    } else if (memoryCache) {
      // Datei (noch) nicht auf dem Branch: gecachte Regeln weiterverwenden,
      // aber den Zeitstempel auffrischen, damit nicht jeder Launch neu lädt.
      memoryCache = { ...memoryCache, fetchedAt: Date.now() }
    } else {
      memoryCache = { fetchedAt: Date.now() }
    }
  } catch (error) {
    // Netzwerk-/Auth-Fehler: der letzte Cache bleibt gültig.
    console.warn('[RetroSync] Overlay-Refresh fehlgeschlagen', error)
  } finally {
    refreshing = false
  }
}

/**
 * Synchronous read for the launch path: serves the in-memory/disk cache and
 * only triggers a background refresh once the TTL has expired.
 */
export function getPromptOverlay(): string | undefined {
  if (!retroSyncConfig().enabled) return undefined
  if (!memoryCache) memoryCache = readDiskCache()
  if (Date.now() - memoryCache.fetchedAt > OVERLAY_TTL_MS) {
    void refreshPromptOverlay()
  }
  return memoryCache.text
}

/** Nur für Tests: Modulzustand zurücksetzen. */
export const promptOverlayInternals = {
  reset(): void {
    memoryCache = undefined
    refreshing = false
  }
}
