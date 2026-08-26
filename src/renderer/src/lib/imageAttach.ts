/**
 * Renderer-side image paste/drop: collect files, insert the relative posix
 * path plus one trailing ASCII space, and decide preventDefault.
 *
 * Saving (bytes, clipboard, absPath) is main-process IPC. This module never
 * touches a worktree path.
 */
export const ATTACHMENT_MAX_FILES = 8
export const IMAGE_NAME = /\.(png|jpe?g|gif|webp|bmp)$/i
const IMAGE_SUBTYPES = new Set(['png', 'jpeg', 'jpg', 'gif', 'webp', 'bmp', 'x-png'])

export type AttachmentSaveResult = { relativePath: string; stagingId?: string }

export type AttachmentSource =
  | 'clipboard'
  | { absPath: string }
  | { bytes: Uint8Array; mime: string }

export function attachmentText(relativePath: string): string {
  return `${relativePath} `
}

export function insertAttachmentText(
  value: string,
  relativePath: string,
  start: number,
  end: number
): { value: string; caret: number } {
  const text = attachmentText(relativePath)
  return {
    value: value.slice(0, start) + text + value.slice(end),
    caret: start + text.length
  }
}

export function isImageFile(file: { name: string; type: string }): boolean {
  if (file.type) {
    const sub = file.type.toLowerCase().replace(/^image\//, '')
    if (file.type.toLowerCase().startsWith('image/') && IMAGE_SUBTYPES.has(sub)) return true
  }
  return IMAGE_NAME.test(file.name)
}

export function clipboardDataLooksLikeImage(data: {
  types?: ArrayLike<string>
  files?: ArrayLike<{ name: string; type: string }>
  items?: ArrayLike<{ type: string }>
} | null): boolean {
  if (!data) return false
  if (data.types && Array.from(data.types).some((type) => type.toLowerCase().startsWith('image/'))) {
    return true
  }
  if (data.items && Array.from(data.items).some((item) => item.type.toLowerCase().startsWith('image/'))) {
    return true
  }
  if (data.files && Array.from(data.files).some(isImageFile)) return true
  return false
}

/** Empty clipboard/nativeImage: caller must NOT preventDefault. */
export function shouldPreventPasteDefault(result: AttachmentSaveResult | null): boolean {
  return result !== null
}

/**
 * Paste-event gate used by goal/composer/CLI. Text-only Ctrl+V must not call
 * save('clipboard') — Windows often still holds a previous screenshot.
 * Returns whether save ran.
 */
export function pasteClipboardImage(
  data: Parameters<typeof clipboardDataLooksLikeImage>[0],
  save: () => void
): boolean {
  if (!clipboardDataLooksLikeImage(data)) return false
  save()
  return true
}

export type DroppedImageSource = { absPath: string } | { bytes: Uint8Array; mime: string }

export function electronFilePath(file: File): string | undefined {
  const path = (file as File & { path?: unknown }).path
  return typeof path === 'string' && path.length > 0 ? path : undefined
}

export function collectDroppedImages(files: ArrayLike<File>): File[] {
  return Array.from(files).filter(isImageFile).slice(0, ATTACHMENT_MAX_FILES)
}

export async function droppedImageSource(file: File): Promise<DroppedImageSource> {
  const absPath = electronFilePath(file)
  if (absPath) return { absPath }
  const bytes = new Uint8Array(await file.arrayBuffer())
  return { bytes, mime: file.type || 'application/octet-stream' }
}

export function trackStagingId(
  ids: readonly string[],
  stagingId: string | undefined
): string[] {
  if (!stagingId) return [...ids]
  return [...ids, stagingId]
}

export function clearIdsWhenGoalEmpty(goal: string, ids: readonly string[]): string[] {
  return goal.trim() ? [...ids] : []
}
