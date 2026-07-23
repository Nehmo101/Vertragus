/**
 * Managed file artifacts: copy into userData when feasible, else keep source reference.
 *
 * Boundary: files larger than MAX_COPY_BYTES are not copied; only sourcePath is stored.
 * Moving or deleting the original file will surface as `missing` in the UI.
 */
import { copyFile, mkdir, stat, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { existsSync } from 'node:fs'

export const MAX_COPY_BYTES = 25 * 1024 * 1024

export function inboxArtifactsRoot(userData: string): string {
  return join(userData, 'inbox-artifacts')
}

export function artifactStorageDir(userData: string, ideaId: string): string {
  return join(inboxArtifactsRoot(userData), ideaId)
}

export async function tryCopyArtifactFile(
  userData: string,
  ideaId: string,
  artifactId: string,
  sourcePath: string
): Promise<{ storedPath?: string; copied: boolean; fileName: string }> {
  const fileName = basename(sourcePath)
  const info = await stat(sourcePath)
  if (!info.isFile()) throw new Error('Pfad ist keine Datei.')

  if (info.size > MAX_COPY_BYTES) {
    return { copied: false, fileName, storedPath: undefined }
  }

  const dir = artifactStorageDir(userData, ideaId)
  await mkdir(dir, { recursive: true })
  const storedPath = join(dir, `${artifactId}-${fileName}`)
  await copyFile(sourcePath, storedPath)
  return { storedPath, copied: true, fileName }
}

/**
 * Persist decoded image bytes under the idea's artifact directory. The filename is
 * derived solely from the server-generated artifactId + a validated extension — the
 * client never influences the path, so there is no traversal surface.
 */
export async function storeImageArtifact(
  userData: string,
  ideaId: string,
  artifactId: string,
  data: Buffer,
  extension: string
): Promise<{ storedPath: string }> {
  const dir = artifactStorageDir(userData, ideaId)
  await mkdir(dir, { recursive: true })
  const storedPath = join(dir, `${artifactId}.${extension}`)
  await writeFile(storedPath, data)
  return { storedPath }
}

export function fileExists(path: string): boolean {
  try {
    return existsSync(path)
  } catch {
    return false
  }
}
