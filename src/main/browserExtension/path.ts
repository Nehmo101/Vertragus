/**
 * Where the unpacked Chromium extension lives.
 *
 * Packaged: `extraResources` copies `extensions/chromium` to
 * `chromium-extension` next to the app. Dev: the repo folder, so Settings
 * can "Load unpacked" and "Reveal folder" without a rebuild.
 *
 * Pure on purpose — unit-tested without Electron.
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'

export const PACKAGED_EXTENSION_DIR = 'chromium-extension'

export function resolveChromiumExtensionDir(input: {
  resourcesPath: string
  candidates?: string[]
}): string {
  const packaged = join(input.resourcesPath, PACKAGED_EXTENSION_DIR)
  if (existsSync(join(packaged, 'manifest.json'))) return packaged
  for (const dir of input.candidates ?? []) {
    if (existsSync(join(dir, 'manifest.json'))) return dir
  }
  return packaged
}
